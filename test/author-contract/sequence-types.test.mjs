import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, types: ['node'], target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
const format = { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' };

function compile(source) {
  const entry = fileURLToPath(new URL('./sequence-type-probe.ts', import.meta.url));
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, source, languageVersion, true) : readSource(file, languageVersion, onError, shouldCreateNewSourceFile));
  return { entry, diagnostics: ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host)) };
}

function accepts(source) {
  const { diagnostics } = compile(source);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, format));
}

function rejects(source, codes) {
  const { entry, diagnostics } = compile(source);
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

const sequenceSetup = `
import { Sequence, Node, type SequenceStep, type CallableOutput, type ChildCalls, type Group } from '@weiliang0121/capix-runtime';
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
import type { ChildCall, Group } from '@weiliang0121/capix-runtime';
declare const call: ChildCall<Group<{ path: string }, { content: string }>>;
function receive<Output>(port: { readonly run: () => Promise<Output> }): Promise<Output> { return port.run(); }
const result: Promise<{ content: string }> = receive(call);
void result;
`);
  rejects(
    `
import type { ChildCall, Group } from '@weiliang0121/capix-runtime';
declare const call: ChildCall<Group<{ path: string }, { content: string }>>;
function receive<Output>(port: { readonly run: () => Promise<Output> }): Promise<Output> { return port.run(); }
const wrong: Promise<{ summary: string }> = receive(call);
`,
    [2322],
  );
});
