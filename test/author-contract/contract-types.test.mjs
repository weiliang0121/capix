import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const options = { strict: true, noEmit: true, skipLibCheck: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true, target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext };
const entry = fileURLToPath(new URL('./types/consumer-contract.ts', import.meta.url));
const source = `
import {Node, Group, defineNode, defineGroup, defineScene} from '@capix/server-runtime';
import type { ChildCall, ChildCalls, ChildContract, ChildContractsOf, ChildOptions, ChildReference, CallableContract, CallableInput, CallableOutput, CallableWork, InvocationOutputReceiver, GroupWork } from '@capix/server-runtime';
import type { ResourceRequest } from '@capix/resources';

declare function expectType<T>(value: T): void;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Input = { readonly path: string };
type Result = { readonly content: string };
const metadata = { name: 'read', label: 'read', source: 'test' };
const read = defineNode<Input, Result>()({ ...metadata, output: { result: value => { throw new Error('not executed'); }, delta: value => String(value) }, run: work => ({ content: work.input.path }) });
const view: CallableContract<'node', Input, Result, string> = read;
// @ts-expect-error a real target cannot widen its accepted input through a shallow view
const widenedInput: CallableContract<'node', unknown, Result, string> = read;
const acceptsUnknown = defineNode<unknown, Result>()({ ...metadata, run: () => ({ content: 'unknown input' }) });
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
const nested = defineGroup<number, number>()({ ...metadata, run: work => work.input });
const task = defineGroup<number, number>()({ members: [nested], run: work => work.input });
const root = defineScene<number, number>()({ members: [task], run: work => work.input });

// An explicit destination type checks a declaration; it never supplies missing resource requests.
const annotatedEmpty: Group<string, number> = defineGroup<string, number>()({ ...metadata, run: work => work.input.length });
const annotatedStream: Group<string, number, Record<string, never>, string> = defineGroup<string, number>()({ ...metadata, output: { result: value => Number(value), delta: value => String(value) }, run: work => work.input.length });
declare const valuePort: ResourceRequest<number>;
const annotatedResources: Group<string, number, { value: number }> = defineGroup<string, number>()({ ...metadata, deps: { value: valuePort },run: work => work.resources.value });
// @ts-expect-error constructor with run cannot invent resource requests
const missingRunResource = new Group<string, number, { value: number }>({ ...metadata, run: () => 1 });

type NoAttemptChildren = Expect<Equal<ChildContractsOf<'node'>, never>>;
expectType<NoAttemptChildren>(true);
// A consumer view is not a new declaration and cannot access implementation.
// @ts-expect-error no implementation on the consumer contract
view.run;
// @ts-expect-error no resource declaration tree on the consumer contract
view.children;
// @ts-expect-error binding inputs still need a complete declaration
const invalidRegisteredChild = defineGroup<string, string>()({ ...metadata, members: [view], run: work => work.input });
// @ts-expect-error shallow objects cannot manufacture definitions at registration
const invalidLiteralChild = defineGroup<string, string>()({ ...metadata, members: [{ kind: 'node' }], run: work => work.input });
// @ts-expect-error Runtime is not any parent's ChildContract
const invalidRoot: ChildContract = root;
// @ts-expect-error even a bare ChildCall cannot refer to R
type RootCall = ChildCall<typeof root>;
// @ts-expect-error a Group cannot acquire a Scene as a member
type InvalidAllowed = CallableWork<'group', number, number, {}, typeof root>;
// @ts-expect-error A has no admissible Allowed even when a generic argument is supplied
type InvalidLeafAllowed = CallableWork<'node', number, number, {}, typeof read>;

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

// A caller can adapt input with an ordinary typed function and retain the shallow target.
const prepareInput = (input: string): Input => ({ path: input });
consumer.children.create(view, prepareInput('notes.md'));
// @ts-expect-error ordinary adaptation retains its declared input contract
prepareInput(2);
const wrongPreparation = (input: string) => ({ path: input.length });
// @ts-expect-error the real child still checks the prepared input type
consumer.children.create(view, wrongPreparation('notes.md'));
// Assembly/composition follows the retained concrete structure explicitly.
read.deps;
// @ts-expect-error structure has no exception interpreter
read.exceptions;

// Shared class registration rules preserve leaf restrictions beyond literals.
class BadLeaf extends Node<Input, Result> {
  readonly name = 'bad'; readonly label = 'bad'; readonly source = 'test';
  // @ts-expect-error a named leaf class cannot declare children
  readonly members = [read];
  readonly deps = {};
readonly run = (work: CallableWork<'node', Input, Result>) => ({ content: work.input.path });
}
class GoodLeaf extends Node<Input, Result> {
  readonly name = 'good'; readonly label = 'good'; readonly source = 'test';
  private readonly prefix = 'result:';
  constructor() { super(); this.run = work => this.project(work.input); }
  private project(input: Input): Result { return { content: this.prefix + input.path }; }
}
const named = new GoodLeaf();
const classRegistration = new Group<Input, Result>().add(named, nested);
// @ts-expect-error the actual Node constructor cannot register members
const invalidClassRegistration = new Node<Input, Result>({ members: [named], run: () => ({ content: '' }) });
const namedParent = defineGroup<Input, Result>()({ ...metadata, members: [named], run: work => work.children.create(named, work.input).run() });

// Ordinary processing rejects the removed stage declaration vocabulary.
// @ts-expect-error uses is not a normal configuration field
const invalidUses = defineGroup<string, string>()({ ...metadata, members: [read], uses: [nested], run: work => work.input });
// @ts-expect-error exception phases are not a callable field
const invalidException = defineGroup<string, string>()({ ...metadata, members: [read], run: work => work.input, exceptions: {} });

// Runtime checks retain real identity and activity rights; structural types do
// not prove registrations, ownership, relation status or a live phase window.
declare const anotherSameShape: typeof read;
const identityStillChecked = defineGroup<Input, Result>()({ ...metadata, members: [read], run(work) { return work.children.create(anotherSameShape, work.input).run(); } });
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
