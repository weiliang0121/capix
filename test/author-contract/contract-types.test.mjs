import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
const entry = fileURLToPath(new URL('./types/consumer-contract.ts', import.meta.url));
const source = `
import {Node, Group, defineNode, defineChildEntry, defineGroup, defineScene} from '@capix/server-runtime';
import type {ChildCall, ChildCalls, ChildContract, ChildContractsOf, ChildEntry, ChildOptions, ChildReference, CallableMembers, CallableContract, CallableInput, CallableOutput, ExecuteWork, InvocationOutputReceiver, GroupWork, ResourceRequest} from '@capix/server-runtime';

declare function expectType<T>(value: T): void;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Input = { readonly path: string };
type Result = { readonly content: string };
const metadata = { name: 'read', label: 'read', source: 'test', callee: 'files' };
const read = defineNode<Input, Result>()({ ...metadata, output: { result: value => { throw new Error('not executed'); }, delta: value => String(value) }, run: { execute: work => ({ content: work.input.path }) } });
const view: CallableContract<'node', Input, Result, string> = read;
// @ts-expect-error a real target cannot widen its accepted input through a shallow view
const widenedInput: CallableContract<'node', unknown, Result, string> = read;
const acceptsUnknown = defineNode<unknown, Result>()({ ...metadata, run: { execute: () => ({ content: 'unknown input' }) } });
// @ts-expect-error facts must not claim a narrower input than the target actually receives
const narrowedInput: CallableContract<'node', Input, Result> = acceptsUnknown;
// Output and Delta remain covariant; hiding detail does not permit a different input.
const resultView: CallableContract<'node', Input, unknown, unknown> = read;
declare const allCalls: ChildCalls;
expectType<Promise<unknown>>(allCalls.create(resultView, { path: 'notes.md' }).run());
// @ts-expect-error output erasure does not erase the input contract
allCalls.create(resultView, 42);
const erased: { readonly kind: 'node' } = read;
// @ts-expect-error an erased signature cannot be relabelled with arbitrary I/O
const forged: CallableContract<'node', number, boolean> = erased;
// @ts-expect-error a level-only view cannot become a callable target
const erasedTarget: ChildContract = erased;
const nested = defineGroup<number, number>()({ ...metadata, run: { execute: work => work.input } });
const task = defineGroup<number, number>()({ members: [nested], run: { execute: work => work.input } });
const root = defineScene<number, number>()({ members: [task], run: { execute: work => work.input } });

// An explicit destination type checks a declaration; it never supplies missing resource requests.
const annotatedEmpty: Group<string, number> = defineGroup<string, number>()({ ...metadata, run: { execute: work => work.input.length } });
const annotatedStream: Group<string, number, Record<string, never>, Record<string, never>, string> = defineGroup<string, number>()({ ...metadata, output: { result: value => Number(value), delta: value => String(value) }, run: { execute: work => work.input.length } });
declare const valuePort: ResourceRequest<number>;
declare const repairPort: ResourceRequest<string>;
const annotatedResources: Group<string, number, { value: number }, { repair: string }> = defineGroup<string, number>()({ ...metadata, run: { requires: { value: valuePort }, execute: work => work.resources.value }, exceptions: { requires: { repair: repairPort }, accepts: [], handle: work => work.return(work.resources.repair.length) } });
// @ts-expect-error the destination type cannot manufacture a run resource request
const missingRunResource = new Group<string, number, { value: number }>({ ...metadata, run: { execute: () => 1 } });
// @ts-expect-error the destination type cannot manufacture an exception resource request
const missingExceptionResource = new Group<string, number, {}, { repair: string }>({ ...metadata, run: { execute: () => 1 }, exceptions: { accepts: [], handle: work => work.unhandled } });

type NoAttemptChildren = Expect<Equal<ChildContractsOf<'node'>, never>>;
expectType<NoAttemptChildren>(true);
// A consumer view is not a new declaration and cannot access implementation.
// @ts-expect-error no implementation on the consumer contract
view.run;
// @ts-expect-error no resource declaration tree on the consumer contract
view.children;
// @ts-expect-error binding inputs still need a complete declaration
const invalidRegisteredChild = defineGroup<string, string>()({ ...metadata, members: [view], run: { execute: work => work.input } });
// @ts-expect-error shallow objects cannot manufacture definitions at registration
const invalidLiteralChild = defineGroup<string, string>()({ ...metadata, members: [{ kind: 'node' }], run: { execute: work => work.input } });
// @ts-expect-error Runtime is not any parent's ChildContract
const invalidRoot: ChildContract = root;
// @ts-expect-error even a bare ChildCall cannot refer to R
type RootCall = ChildCall<typeof root>;
// @ts-expect-error a Group cannot acquire a Scene as a member
type InvalidAllowed = ExecuteWork<'group', number, number, {}, typeof root>;
// @ts-expect-error A has no admissible Allowed even when a generic argument is supplied
type InvalidLeafAllowed = ExecuteWork<'node', number, number, {}, typeof read>;

// A bounded consumer can use the same object through its shallow signature.
declare const consumer: GroupWork<string, string, {}, typeof view>;
const call = consumer.children.create(view, { path: 'notes.md' }, { output: { receive(event) {
  if (event.kind === 'delta') expectType<string>(event.delta);
  if (event.kind === 'completed') expectType<Result>(event.result);
  return undefined;
} } });
expectType<Promise<Result>>(call.run());
expectType<Promise<number>>(call.accept(result => result.content.length));
const facts = consumer.children.facts.get(call.ref);
expectType<Input>(facts.input);
if (facts.returned?.status === 'succeeded') expectType<Result>(facts.returned.output);
// @ts-expect-error input must match the child signature
consumer.children.create(view, { path: 42 });
// @ts-expect-error output receiver remains tied to the child Delta
const invalidOutput: ChildOptions<typeof view> = { output: { receive(event) { if (event.kind === 'delta') expectType<number>(event.delta); return undefined; } } };
// @ts-expect-error phase Allowed cannot expand to a different contract
consumer.children.create(nested, 1);

// Entry consumers need input adaptation, not Sequence's implementation getters.
const entry = defineChildEntry(read, { accept(request: { input: string }) { return { path: request.input }; } });
const entryView: ChildEntry<typeof view, string> = entry;
consumer.children.entry(entryView, 'notes.md');
const customEntry: ChildEntry<typeof view, string> = { definition: view, accept(request) {
  expectType<string>(request.input);
  expectType<1 | 2>(request.facts.round);
  expectType<string | undefined>(request.key);
  request.facts.children.get(call.ref);
  return { path: request.input };
} };
consumer.children.entry(customEntry, 'notes.md');
// @ts-expect-error input adaptation does not widen its external input
consumer.children.entry(entryView, 2);
// @ts-expect-error caller sees no complete run declaration through entryView
entryView.run;
// The actual entry retains these for assembly/composition.
entry.run?.requires;
entry.exceptions;

// Shared class registration rules preserve leaf restrictions beyond literals.
class BadLeaf extends Node<Input, Result> {
  readonly name = 'bad'; readonly label = 'bad'; readonly source = 'test'; readonly callee = 'local';
  // @ts-expect-error a named leaf class cannot declare children
  readonly members = [read];
  readonly run = { requires: {}, execute: (work: ExecuteWork<'node', Input, Result>) => ({ content: work.input.path }) };
}
class GoodLeaf extends Node<Input, Result> {
  readonly name = 'good'; readonly label = 'good'; readonly source = 'test'; readonly callee = 'local';
  private readonly prefix = 'result:';
  constructor() { super(); this.setRun({ execute: work => this.project(work.input) }); }
  private project(input: Input): Result { return { content: this.prefix + input.path }; }
}
const named = new GoodLeaf();
const classRegistration: CallableMembers<'group'> = { members: [named, nested] };
// @ts-expect-error common registration type retains the parent's exact position
const invalidClassRegistration: CallableMembers<'node'> = { members: [named] };
const namedParent = defineGroup<Input, Result>()({ ...metadata, members: [named], run: { execute: work => work.children.create(named, work.input).run() } });

// Registration and stage selection cannot be inferred backwards from uses.
// @ts-expect-error run uses cannot add an unregistered different child
const invalidUses = defineGroup<string, string>()({ ...metadata, members: [read], run: { uses: [nested], execute: work => work.input } });
// @ts-expect-error exception uses cannot add an unregistered different child
const invalidExceptionUses = defineGroup<string, string>()({ ...metadata, members: [read], run: { execute: work => work.input }, exceptions: { accepts: [], uses: [nested], handle: work => work.unhandled } });

// Runtime checks retain real identity and activity rights; structural types do
// not prove registrations, ownership, relation status or a live phase window.
declare const anotherSameShape: typeof read;
const identityStillChecked = defineGroup<Input, Result>()({ ...metadata, members: [read], run: { execute(work) { return work.children.create(anotherSameShape, work.input).run(); } } });
declare const history: ChildReference<typeof view>;
declare const noActions: GroupWork<string, string, {}, never>;
noActions.children.facts.get(history);
noActions.children.open(history);
// @ts-expect-error old references do not grant new creation rights
noActions.children.create(view, { path: 'notes.md' });
`;

function diagnostics(text) {
  const host = ts.createCompilerHost(options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError, shouldCreateNewSourceFile) => (file === entry ? ts.createSourceFile(file, text, languageVersion, true) : originalGetSourceFile(file, languageVersion, onError, shouldCreateNewSourceFile));
  return ts.getPreEmitDiagnostics(ts.createProgram([entry], options, host));
}
function format(items) {
  return ts.formatDiagnosticsWithColorAndContext(items, { getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => '\n' });
}

test('shallow consumers preserve I/O, phases and positions while registration still requires complete declarations', () => {
  const errors = diagnostics(source);
  assert.equal(errors.length, 0, format(errors));
});
test('consumer and registration type failures are real diagnostics at author sites', () => {
  const errors = diagnostics(source.replaceAll('@ts-expect-error', 'expected compile error'));
  const count = source.match(/@ts-expect-error/g)?.length ?? 0;
  assert.equal(errors.length, count, format(errors));
  assert.ok(
    errors.every((error) => error.file?.fileName === entry),
    format(errors),
  );
});
