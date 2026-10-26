import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, types: ['node'], target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
const format = { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' };

function compile(source, withinService = false) {
  // The service-local helper stays internal. Its virtual caller belongs to the same package.
  const entry = fileURLToPath(new URL(withinService ? '../../services/observer/src/conversation/decision/helper-type-probe.ts' : './helper-type-probe.ts', import.meta.url));
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, source, languageVersion, true) : readSource(file, languageVersion, onError, shouldCreateNewSourceFile));
  return { entry, diagnostics: ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host)) };
}

function accepts(source, withinService = false) {
  const { diagnostics } = compile(source, withinService);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, format));
}

function rejects(source, codes, withinService = false) {
  const { entry, diagnostics } = compile(source, withinService);
  assert.deepEqual(
    diagnostics.map((diagnostic) => diagnostic.code),
    codes,
    ts.formatDiagnosticsWithColorAndContext(diagnostics, format),
  );
  assert.ok(
    diagnostics.every((diagnostic) => diagnostic.file?.fileName === entry),
    'rejection must occur at the helper call, not inside production declarations',
  );
}

const capabilitySetup = `
import {z} from 'zod';
import type { ChildCalls, Group } from '@capix/server-runtime';
import {conversationCapability} from './capability.js';
declare const read: Group<{ path: string }, { content: string }, {}, { text: string }>;
declare const summary: Group<{ text: string }, { summary: string }>;
declare const readOnly: ChildCalls<typeof read>;
declare const both: ChildCalls<typeof read | typeof summary>;
interface State { text: string }
const schema = z.strictObject({ path: z.string() });
const options = {
  name: 'document' as const,
  description: 'Read the selected path',
  use: read,
  key: 'read',
  schema,
  available: (_state: State) => true,
  input: (arguments_: { path: string }) => arguments_,
  accept: (value: { content: string }, state: State) => ({ ...state, text: value.content }),
};
`;

test('the actual capability adapter accepts both narrow and wider grants without losing callback types', () => {
  accepts(
    `${capabilitySetup}
conversationCapability(options, readOnly);
conversationCapability({ ...options, output: { receive: (event) => { if (event.kind === 'delta') { const text: string = event.delta.text; void text; } return undefined; } } }, both);
`,
    true,
  );
});

test('the actual capability adapter cannot infer an undeclared child from a narrow grant', () => {
  rejects(
    `${capabilitySetup}
conversationCapability({ ...options, use: summary, input: (arguments_: { path: string }) => ({ text: arguments_.path }), accept: (value: { summary: string }, state: State) => ({ ...state, text: value.summary }) }, readOnly);
`,
    [2345],
    true,
  );
});

test('capability input, accepted output and delta remain anchored to its real declaration', () => {
  rejects(
    `${capabilitySetup}
conversationCapability({ ...options, input: () => ({ path: 1 }) }, both);
conversationCapability({ ...options, accept: (value: { summary: string }, state: State) => ({ ...state, text: value.summary }) }, both);
conversationCapability({ ...options, output: { receive: (event) => { if (event.kind === 'delta') { const wrong: number = event.delta.text; void wrong; } return undefined; } } }, both);
`,
    [2322, 2322, 2322],
    true,
  );
});

const sequenceSetup = `
import { Sequence, Node, type SequenceStep, type CallableOutput, type ChildCalls, type Group } from '@capix/server-runtime';
declare const read: Group<{ path: string }, { content: string }, {}, { text: string }>;
declare const summary: Group<{ text: string }, { summary: string }>;
declare const exists: Group<{ path: string }, { exists: boolean }>;
declare const both: ChildCalls<typeof read | typeof summary>;
const readStep = { node: read, input: ({ input }) => ({ path: input }), delta: (value, _scope) => { const text: string = value.text; void text; } } satisfies SequenceStep<typeof read, string>;
const summaryStep = { node: summary, input: ({ previous }) => ({ text: previous.content }), result: { succeeded: (value, _scope) => value.summary.length } } satisfies SequenceStep<typeof summary, string, { content: string }>;
const sequence = new Sequence([readStep, summaryStep]);
`;

test('Sequence carries the final accepted type as an ordinary Group signature', () => {
  accepts(`${sequenceSetup}
const output: CallableOutput<typeof sequence> = 1;
const group: Group<string, number> = sequence;
const alternative = new Sequence([{ node: read, input: ({ input }: { input: number }) => ({ path: String(input) }) }]);
const adapted: CallableOutput<typeof alternative> = { content: 'value' };
const emptySequence = new Sequence([]);
const empty: CallableOutput<typeof emptySequence> = 'empty';
void output; void group; void adapted; void empty;
`);
});

test('Sequence rejects incompatible implicit and explicitly adapted inputs', () => {
  rejects(
    `${sequenceSetup}
new Sequence([new Node<string, string>(), read]);
new Sequence([{ node: summary, input: () => ({ text: 1 }) }]);
`,
    [2345, 2345],
  );
});

test('Sequence final-result annotations cannot claim the retired named-output map', () => {
  accepts(`${sequenceSetup}
const explicit: Group<string, number> = sequence;
const result: CallableOutput<typeof explicit> = 12;
void result;
`);
  rejects(
    `${sequenceSetup}
const erased: Group<string, { read: { content: string }; summary: number }> = sequence;
`,
    [2322],
  );
});

test('presets preserve supported unions and ordinary dispatch still narrows child inputs', () => {
  accepts(`${sequenceSetup}
declare const selected: typeof read | typeof exists;
const one = new Sequence([{ node: selected, input: ({ input }: { input: string }) => ({ path: input }) }]);
const unionOutput: CallableOutput<typeof one> = { exists: true };
type Request = { kind: 'read'; input: { path: string } } | { kind: 'summary'; input: { text: string } };
function dispatch(request: Request) {
  if (request.kind === 'read') return both.create(read, request.input).run();
  return both.create(summary, request.input).run();
}
void unionOutput; void dispatch;
`);
});

test('output-only helpers infer the returned value without the whole declaration tree', () => {
  accepts(`
import type { ChildCall, Group } from '@capix/server-runtime';
declare const call: ChildCall<Group<{ path: string }, { content: string }>>;
function receive<Output>(port: { readonly run: () => Promise<Output> }): Promise<Output> { return port.run(); }
const result: Promise<{ content: string }> = receive(call);
void result;
`);
  rejects(
    `
import type { ChildCall, Group } from '@capix/server-runtime';
declare const call: ChildCall<Group<{ path: string }, { content: string }>>;
function receive<Output>(port: { readonly run: () => Promise<Output> }): Promise<Output> { return port.run(); }
const wrong: Promise<{ summary: string }> = receive(call);
`,
    [2322],
  );
});
