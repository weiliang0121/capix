import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
const entry = fileURLToPath(new URL('./types/checkpoint-contract.ts', import.meta.url));
const source = `
import { checkpointPoint, childReference, childReferences, defineNode, defineGroup, defineScene } from '@weiliang0121/capix-runtime';
import type { AuthorCheckpointWriter, CheckpointCodec, CheckpointPointOwner, ChildReference, ChildReferenceSlot, CallableContract, InvocationCheckpointDefinition, InvocationCheckpointPoint } from '@weiliang0121/capix-runtime';
import type { ResourceRequest } from '@weiliang0121/capix-resources';

type Input = { readonly query: string };
type Output = { readonly answer: string };
type State = { readonly cursor: number };
type ChildInput = { readonly path: string };
type ChildOutput = { readonly text: string };
declare const inputCodec: CheckpointCodec<Input>;
declare const outputCodec: CheckpointCodec<Output>;
declare const stateCodec: CheckpointCodec<State>;
declare const pathCodec: CheckpointCodec<{ readonly path: string }>;
declare const numberCodec: CheckpointCodec<number>;
declare const checkOutput: (value: unknown) => Output;
declare const checkDelta: (value: unknown) => string;
declare const lookup: ResourceRequest<{ readonly at: (cursor: number) => string }>;
declare const writer: AuthorCheckpointWriter<'group', Input, Output, string>;

const metadata = { label: 'test', source: 'test' };
const read = defineNode<ChildInput, ChildOutput>()({ ...metadata, name: 'read', run: work => ({ text: work.input.path }) });
const wrongRead = defineNode<{ readonly path: number }, ChildOutput>()({ ...metadata, name: 'wrong-read', run: work => ({ text: String(work.input.path) }) });
const nested = defineGroup<ChildInput, ChildOutput>()({ ...metadata, name: 'nested', run: work => ({ text: work.input.path }) });
const execution = defineGroup<Input, Output>()({ run: work => ({ answer: work.input.query }) });
declare const readRef: ChildReference<typeof read>;
declare const wrongReadRef: ChildReference<typeof wrongRead>;
declare const nestedRef: ChildReference<typeof nested>;

const waiting = checkpointPoint<'group', Input, Output, string>()({
  name: 'waiting', state: stateCodec,
  references: { one: childReference(read), batch: childReferences(read) },
  check(state, facts) {
    const cursor: number = state.cursor;
    const input: Input = facts.input;
    const initial: Input = facts.initialInput;
    const single: ChildInput = facts.references.one.input;
    const many: readonly ChildInput[] = facts.references.batch.map(fact => fact.input);
    // @ts-expect-error state is fixed by the codec
    const wrongState: string = state.cursor;
    // @ts-expect-error check is fact-only, not a phase Work
    facts.resources;
  },
  resume: { deps: { lookup }, uses: [read], run(work, state, saved) {
    const path: string = work.resources.lookup.at(state.cursor);
    const restored = work.children.resume(saved.one);
    const result: Promise<ChildOutput> = restored.run();
    const single: ChildReference<typeof read> = saved.one;
    const many: readonly ChildReference<typeof read>[] = saved.batch;
    work.output.emit(path);
    work.children.create(read, { path });
    work.children.facts.get(nestedRef);
    work.children.open(nestedRef);
    // @ts-expect-error resources are inferred solely from deps
    work.resources.other;
    // @ts-expect-error the resource method keeps its real argument type
    work.resources.lookup.at('bad');
    // @ts-expect-error uses does not include nested
    work.children.create(nested, { path });
    // @ts-expect-error historical access does not grant resume rights
    work.children.resume(nestedRef);
    // @ts-expect-error point Delta is string
    work.output.emit(1);
    // @ts-expect-error saved one is not an array
    const wrongMany: readonly ChildReference<typeof read>[] = saved.one;
    // @ts-expect-error saved batch is not a single reference
    const wrongSingle: ChildReference<typeof read> = saved.batch;
    return { answer: path };
  } },
});

const settled = checkpointPoint<'group', Input, Output, string>()({
  name: 'settled', state: pathCodec, references: { prior: childReference(nested) },
  resume: { run(work, state, saved) {
    work.children.open(saved.prior);
    work.children.facts.get(saved.prior);
    // @ts-expect-error omitted deps stays empty
    work.resources.lookup;
    // @ts-expect-error omitted uses stays empty
    work.children.create(nested, { path: state.path });
    // @ts-expect-error a saved reference does not add an action grant
    work.children.resume(saved.prior);
    return { answer: state.path };
  } },
});

const leafPoint = checkpointPoint<'node', Input, Output>()({
  name: 'leaf', state: numberCodec, references: {},
  resume: { run(work, state) {
    const count: number = state;
    // @ts-expect-error A has no children surface
    work.children;
    // @ts-expect-error no Delta means no output writer
    work.output;
    return { answer: work.input.query };
  } },
});
const executionPoint = checkpointPoint<'group', Input, Output>()({ name: 'e', state: numberCodec, references: { child: childReference(nested) }, resume: { uses: [nested], run: work => ({ answer: work.input.query }) } });
const runtimePoint = checkpointPoint<'scene', Input, Output>()({ name: 'r', state: numberCodec, references: { child: childReference(execution) }, resume: { uses: [execution], run: work => ({ answer: work.input.query }) } });
// Slots and resume actions need only the original child's shallow signature.
const shallowRead: CallableContract<'node', ChildInput, ChildOutput> = read;
const shallowPoint = checkpointPoint<'group', Input, Output, string>()({ name: 'shallow', state: numberCodec, references: { child: childReference(shallowRead) }, resume: { uses: [shallowRead], async run(work, state, saved) {
  const result: ChildOutput = await work.children.resume(saved.child).run();
  return { answer: result.text };
} } });

const checkpoint = { key: 'op', version: 1, input: inputCodec, output: outputCodec, points: [waiting, settled, shallowPoint] } satisfies InvocationCheckpointDefinition<Input, Output, 'group', string>;
defineGroup<Input, Output>()({ ...metadata, name: 'operation', members: [read, nested], output: { result: checkOutput, delta: checkDelta }, checkpoint, run: work => ({ answer: work.input.query }) });
defineNode<Input, Output>()({ ...metadata, name: 'leaf', checkpoint: { key: 'a', version: 1, input: inputCodec, output: outputCodec, points: [leafPoint] }, run: work => ({ answer: work.input.query }) });
defineGroup<Input, Output>()({ members: [nested], checkpoint: { key: 'e', version: 1, input: inputCodec, output: outputCodec, points: [executionPoint] }, run: work => ({ answer: work.input.query }) });
defineScene<Input, Output>()({ members: [execution], checkpoint: { key: 'r', version: 1, input: inputCodec, output: outputCodec, points: [runtimePoint] }, run: work => ({ answer: work.input.query }) });

writer({ point: waiting, state: { cursor: 1 }, refs: { one: readRef, batch: [readRef, readRef] } });
const selection = writer.select(read);
const firstOccurrence = selection.add(readRef);
selection.add(readRef);
selection.remove(firstOccurrence);
const recoveredOccurrence = selection.occurrenceAt(-1);
if (recoveredOccurrence) selection.remove(recoveredOccurrence);
const selectedRef: ChildReference<typeof read> | undefined = selection.at(-1);
const selectedRefs: readonly ChildReference<typeof read>[] = [...selection];
writer({ point: waiting, state: { cursor: 1 }, refs: { one: readRef, batch: selection } });
writer.select(read, [readRef, readRef]);
// @ts-expect-error a selection cannot add another declaration's I/O
selection.add(wrongReadRef);
// @ts-expect-error initial references do not widen the target declaration
writer.select(read, [wrongReadRef]);
// @ts-expect-error a selection is only valid in a many slot
writer({ point: waiting, state: { cursor: 1 }, refs: { one: selection, batch: [] } });
// @ts-expect-error many selection target remains exact
writer({ point: waiting, state: { cursor: 1 }, refs: { one: readRef, batch: writer.select(wrongRead) } });
// @ts-expect-error occurrence identities cannot be invented
selection.remove({});
// @ts-expect-error selection length is read-only
selection.length = 0;
declare const leafWriter: AuthorCheckpointWriter<'node', Input, Output>;
// @ts-expect-error nodes have no member selection
leafWriter.select(read);
writer({ point: settled, state: { path: 'done' }, refs: { prior: nestedRef } });
// @ts-expect-error checkpoint cannot widen State from its value
writer({ point: waiting, state: { cursor: 'bad' }, refs: { one: readRef, batch: [readRef] } });
// @ts-expect-error state from another point is not interchangeable
writer({ point: waiting, state: { path: 'bad' }, refs: { one: readRef, batch: [readRef] } });
// @ts-expect-error required slot is missing
writer({ point: waiting, state: { cursor: 1 }, refs: { one: readRef } });
// @ts-expect-error single slot does not accept multiple refs
writer({ point: waiting, state: { cursor: 1 }, refs: { one: [readRef], batch: [readRef] } });
// @ts-expect-error ref I/O must match the slot's child
writer({ point: waiting, state: { cursor: 1 }, refs: { one: wrongReadRef, batch: [readRef] } });
// @ts-expect-error refs from another point do not expand this point
writer({ point: settled, state: { path: 'done' }, refs: { one: readRef } });

// @ts-expect-error owner level differs
const wrongLevel: CheckpointPointOwner<'scene', Input, Output, string> = waiting;
// @ts-expect-error owner input differs
const wrongInput: CheckpointPointOwner<'group', { readonly query: number }, Output, string> = waiting;
// @ts-expect-error owner output differs
const wrongOutput: CheckpointPointOwner<'group', Input, { readonly answer: number }, string> = waiting;
// @ts-expect-error owner does not support the point's Delta
const wrongDelta: CheckpointPointOwner<'group', Input, Output, number> = waiting;
// @ts-expect-error point cannot be registered with a different owner level
const wrongParent: InvocationCheckpointDefinition<Input, Output, 'scene', string> = checkpoint;
// @ts-expect-error checkpoint cannot override the parent's declared I/O
defineGroup<Input, { readonly answer: number }>()({ ...metadata, name: 'wrong-owner', checkpoint, run: () => ({ answer: 1 }) });
// @ts-expect-error checkpoint cannot invent an output Delta for its owner
defineGroup<Input, Output>()({ ...metadata, name: 'missing-output', checkpoint, run: () => ({ answer: '' }) });
// @ts-expect-error resume output follows owner O
checkpointPoint<'group', Input, Output>()({ name: 'bad-output', state: numberCodec, references: {}, resume: { run: () => ({ answer: 1 }) } });
// @ts-expect-error check annotation cannot change codec State
checkpointPoint<'group', Input, Output>()({ name: 'bad-check', state: numberCodec, references: {}, check: (state: string) => {}, resume: { run: () => ({ answer: '' }) } });
// @ts-expect-error resume annotation cannot change codec State
checkpointPoint<'group', Input, Output>()({ name: 'bad-state', state: numberCodec, references: {}, resume: { run: (work, state: string) => ({ answer: '' }) } });

// Factory and explicit interfaces share structural membership and stage grants.
// @ts-expect-error A has no direct children for references
checkpointPoint<'node', Input, Output>()({ name: 'bad-a-ref', state: numberCodec, references: { child: childReference(read) }, resume: { run: () => ({ answer: '' }) } });
// Composite scopes support these formerly level-specific relationships.
checkpointPoint<'group', Input, Output>()({ name: 'bad-e-ref', state: numberCodec, references: { child: childReference(read) }, resume: { run: () => ({ answer: '' }) } });
// Composite scopes support these formerly level-specific relationships.
checkpointPoint<'scene', Input, Output>()({ name: 'bad-r-ref', state: numberCodec, references: { child: childReference(read) }, resume: { run: () => ({ answer: '' }) } });
// Composite scopes support these formerly level-specific relationships.
checkpointPoint<'group', Input, Output>()({ name: 'bad-o-ref', state: numberCodec, references: { child: childReference(execution) }, resume: { run: () => ({ answer: '' }) } });
// Composite scopes support these formerly level-specific relationships.
type BadExecutionPoint = InvocationCheckpointPoint<Input, Output, 'group', number, {}, { child: ChildReferenceSlot<typeof read, false> }>;
// @ts-expect-error explicit A point cannot declare a child slot
type BadAttemptPoint = InvocationCheckpointPoint<Input, Output, 'node', number, {}, { child: ChildReferenceSlot<typeof read, false> }>;
// @ts-expect-error A cannot declare uses
checkpointPoint<'node', Input, Output>()({ name: 'bad-a-uses', state: numberCodec, references: {}, resume: { uses: [read], run: () => ({ answer: '' }) } });
// Composite scopes support these formerly level-specific relationships.
checkpointPoint<'group', Input, Output>()({ name: 'bad-e-uses', state: numberCodec, references: {}, resume: { uses: [read], run: () => ({ answer: '' }) } });

const explicit: InvocationCheckpointPoint<Input, Output, 'group', number> = {
  name: 'explicit-defaults', state: numberCodec, references: {}, resume: { deps: {}, run(work) {
    work.children.open(readRef);
    work.children.facts.get(readRef);
    // @ts-expect-error explicit point action defaults match the empty resume uses
    work.children.create(read, { path: '' });
    // @ts-expect-error explicit point cannot resume without a declared action grant
    work.children.resume(readRef);
    return { answer: work.input.query };
  } },
};

// A point may use a subset of an owner's output capability.
const noDelta = checkpointPoint<'group', Input, Output>()({ name: 'no-delta', state: numberCodec, references: {}, resume: { run: () => ({ answer: '' }) } });
const widerDeltaOwner: CheckpointPointOwner<'group', Input, Output, string | number> = waiting;
const noDeltaForStreamOwner: CheckpointPointOwner<'group', Input, Output, string> = noDelta;

// Object identity and parent/point registration still require binding checks.
const sameShapedUnregisteredPoint = checkpointPoint<'group', Input, Output, string>()({ name: 'elsewhere', state: stateCodec, references: { one: childReference(read), batch: childReferences(read) }, resume: { run: () => ({ answer: '' }) } });
writer({ point: sameShapedUnregisteredPoint, state: { cursor: 1 }, refs: { one: readRef, batch: [readRef] } });
`;

function diagnosticsFor(text) {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => (name === entry ? ts.createSourceFile(name, text, languageVersion, true) : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile));
  return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
}

function format(diagnostics) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
}

test('checkpoint authors retain exact point state, references, owner and independent resume capabilities', () => {
  const diagnostics = diagnosticsFor(source);
  assert.equal(diagnostics.length, 0, format(diagnostics));
});

test('checkpoint type boundaries reject author errors without suppression directives', () => {
  const lines = source.split('\n');
  const expectedLines = lines.flatMap((line, index) => (line.includes('@ts-expect-error') ? [index + 1] : []));
  const diagnostics = diagnosticsFor(lines.map((line) => (line.includes('@ts-expect-error') ? '' : line)).join('\n'));
  assert.ok(
    diagnostics.every((diagnostic) => diagnostic.file?.fileName === entry),
    'negative fixtures must fail at the author usage, not in production declarations',
  );
  const actualLines = [...new Set(diagnostics.map((diagnostic) => diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line))];
  assert.deepEqual(actualLines, expectedLines, format(diagnostics));
});
