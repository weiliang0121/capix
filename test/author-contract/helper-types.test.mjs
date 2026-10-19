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
import { z } from 'zod';
import type { ChildCalls, OperationDefinition } from '@capix/server-runtime';
import { conversationCapability } from './capability.js';
declare const read: OperationDefinition<{ path: string }, { content: string }, {}, {}, { text: string }>;
declare const summary: OperationDefinition<{ text: string }, { summary: string }>;
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
import { Sequence, InvocationEntry, type ChildCalls, type ChildDefinition, type OperationDefinition } from '@capix/server-runtime';
declare const read: OperationDefinition<{ path: string }, { content: string }, {}, {}, { text: string }>;
declare const summary: OperationDefinition<{ text: string }, { summary: string }>;
declare const exists: OperationDefinition<{ path: string }, { exists: boolean }>;
declare const readOnly: ChildCalls<typeof read>;
declare const both: ChildCalls<typeof read | typeof summary>;
declare const all: ChildCalls<typeof read | typeof summary | typeof exists>;
const sequence = new Sequence<string>()
  .step('read', { use: read, input: ({ input }) => ({ path: input }), output: () => ({ receive: event => { if (event.kind === 'delta') { const text: string = event.delta.text; void text; } return undefined; } }) })
  .step('summary', { use: summary, input: ({ outputs }) => ({ text: outputs.read.content }), accept: (_scope, value) => value.summary.length });
`;

test('Sequence preserves each accepted output while requiring only its complete phase grant', () => {
  accepts(`${sequenceSetup}
const output: Promise<Readonly<{ read: { content: string }; summary: number }>> = sequence.run('notes.md', both);
const wider: Promise<Readonly<{ read: { content: string }; summary: number }>> = sequence.run('notes.md', all);
const entry = new InvocationEntry(read, ({ input }: { input: number }) => ({ path: String(input) }));
const alternative = new Sequence<number>().step('read', { use: entry, input: ({ input }) => input });
const adapted: Promise<Readonly<{ read: { content: string } }>> = alternative.run(12, readOnly);
const empty: Promise<Readonly<{}>> = new Sequence<string>().run('empty', readOnly);
void output; void wider; void adapted; void empty;
`);
});

test('Sequence rejects a missing grant for both direct and adapted child input', () => {
  rejects(
    `${sequenceSetup}
sequence.run('notes.md', readOnly);
const entry = new InvocationEntry(summary, ({ input }: { input: number }) => ({ text: String(input) }));
new Sequence<number>().step('summary', { use: entry, input: ({ input }) => input }).run(12, readOnly);
`,
    [2345, 2345],
  );
});

test('explicit Sequence annotations retain the used declarations instead of erasing their phase grant', () => {
  accepts(`${sequenceSetup}
const explicit: Sequence<string, { read: { content: string }; summary: number }, typeof read | typeof summary> = sequence;
const result: Promise<Readonly<{ read: { content: string }; summary: number }>> = explicit.run('notes.md', both);
declare const unrestricted: ChildCalls;
const widened: Sequence<string, { read: { content: string }; summary: number }, ChildDefinition> = sequence;
widened.run('notes.md', unrestricted);
void result;
`);
  rejects(
    `${sequenceSetup}
const erased: Sequence<string, { read: { content: string }; summary: number }> = sequence;
const widened: Sequence<string, { read: { content: string }; summary: number }, ChildDefinition> = sequence;
widened.run('notes.md', readOnly);
`,
    [2322, 2345],
  );
});

test('helpers preserve supported unions and dynamic dispatch narrows input before selecting a declaration', () => {
  accepts(`${sequenceSetup}
declare const selected: typeof read | typeof exists;
const one = new Sequence<string>().step('selected', { use: selected, input: ({ input }) => ({ path: input }) });
const unionOutput: Promise<Readonly<{ selected: { content: string } | { exists: boolean } }>> = one.run('notes.md', all);
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
import type { ChildCall, OperationDefinition } from '@capix/server-runtime';
declare const call: ChildCall<OperationDefinition<{ path: string }, { content: string }>>;
function receive<Output>(port: { readonly run: () => Promise<Output> }): Promise<Output> { return port.run(); }
const result: Promise<{ content: string }> = receive(call);
void result;
`);
  rejects(
    `
import type { ChildCall, OperationDefinition } from '@capix/server-runtime';
declare const call: ChildCall<OperationDefinition<{ path: string }, { content: string }>>;
function receive<Output>(port: { readonly run: () => Promise<Output> }): Promise<Output> { return port.run(); }
const wrong: Promise<{ summary: string }> = receive(call);
`,
    [2322],
  );
});
