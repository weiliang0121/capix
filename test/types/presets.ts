import { Sequence, Node, Group, Scene, type SequenceStep, type CallableInput, type CallableOutput } from '@capix/structure';
import { Runner, Resources } from '@capix/server-runtime';

declare function expectType<Value>(value: Value): void;
type Request = { source: string; destination: string };
const read = new Node<{ path: string }, { text: string }, {}, string>({ output: { result: () => ({ text: '' }), delta: String }, run: () => ({ text: 'hello' }) });
const translate = new Node<{ text: string }, string>({ run: (work) => work.input.text });
const length = new Node<string, number>({ run: (work) => work.input.length });
const first = {
  node: read,
  input: ({ input, previous }) => {
    expectType<string>(input.source);
    expectType<string>(previous.destination);
    return { path: input.source };
  },
  delta: (delta, scope) => {
    expectType<string>(delta);
    expectType<string>(scope.input.destination);
  },
} satisfies SequenceStep<typeof read, Request>;
const last = {
  node: length,
  result: {
    succeeded: async (value, scope) => {
      expectType<number>(value);
      expectType<string>(scope.previous);
      return { length: value, destination: scope.input.destination };
    },
  },
} satisfies SequenceStep<typeof length, Request, string>;
const sequence = new Sequence([first, translate, last]);
expectType<Group<Request, { length: number; destination: string }>>(sequence);
expectType<{ length: number; destination: string }>(null! as CallableOutput<typeof sequence>);
expectType<Request>(null! as CallableInput<typeof sequence>);

const inferred = new Sequence([length]);
expectType<number>(null! as CallableOutput<typeof inferred>);
expectType<string>(null! as CallableInput<typeof inferred>);
const alias = inferred;
// @ts-expect-error fixed pipelines have no mutating step API
alias.step(translate);
// @ts-expect-error progression cannot be replaced with a different return contract
alias.run = () => 1;
expectType<number>(null! as CallableOutput<typeof alias>);
const empty = new Sequence([]);
expectType<unknown>(null! as CallableOutput<typeof empty>);
// @ts-expect-error an empty untyped pipeline cannot claim a particular output
expectType<string>(null! as CallableOutput<typeof empty>);

const streaming = new Node<string, string, {}, string>();
const forward = { node: streaming, delta: (value, scope) => scope.output.emit(value) } satisfies SequenceStep<typeof streaming, string, string, string>;
const forwarded = new Sequence([forward], { output: { result: String, delta: String } });
expectType<Group<string, string, {}, string>>(forwarded);
// @ts-expect-error an explicit Delta also requires an actual delta declaration
new Sequence<readonly [typeof forward], string>([forward]);
// @ts-expect-error a result-only output does not provide a delta writer
new Sequence<readonly [typeof forward], string>([forward], { output: { result: String } });
// @ts-expect-error a fixed output declaration cannot be removed before build
forwarded.output = undefined;
// @ts-expect-error a step cannot claim a parent output writer that was not declared
new Sequence([forward]);

const handled = new Sequence([{ node: length, result: { failed: () => false as const } }]);
expectType<number | false>(null! as CallableOutput<typeof handled>);
const changed = { node: length, result: { succeeded: (value) => String(value) } } satisfies SequenceStep<typeof length>;
const received = new Sequence([changed, length]);
expectType<number>(null! as CallableOutput<typeof received>);
const labelled = new Sequence([{ node: read, input: ({ input }: { input: Request }) => ({ path: input.source }) }, translate]);
expectType<Group<Request, string>>(labelled);

// @ts-expect-error number cannot supply a following string node
new Sequence([length, length]);
// @ts-expect-error wrapping a node does not bypass implicit-input validation
new Sequence([length, { node: length }]);
// @ts-expect-error explicit adaptation must return the selected node's input
new Sequence([{ node: read, input: () => ({ path: 1 }) }]);
// @ts-expect-error reception callback input is anchored to the child's output
new Sequence([{ node: length, result: { succeeded: (value: string) => value } }]);
// @ts-expect-error undeclared child Delta cannot acquire a receiver
new Sequence([{ node: length, delta: () => {} }]);
// @ts-expect-error a Scene cannot be a sequence member
new Sequence([new Scene()]);

declare const ambiguousMember: Node<string, string> | Node<number, string>;
// @ts-expect-error no input can safely call an unresolved string-or-number member
new Sequence([ambiguousMember]);
// @ts-expect-error an adapter cannot guess which member input is selected
new Sequence([{ node: ambiguousMember, input: () => 'guess' }]);
declare const wide: (typeof length)[];
// @ts-expect-error a widened array has no proven first/last or adjacent step order
new Sequence(wide);
// @ts-expect-error output is inferred from the pipeline, not from an unrelated validator
new Sequence([length], { output: { result: String } });

const numberOnly = new Node<number, number>();
// @ts-expect-error reception result unions must all be accepted by the following node
new Sequence([{ node: length, result: { failed: () => false as const } }, numberOnly]);
declare const optionalReception: { readonly node: typeof length; readonly result?: { readonly succeeded: (value: number) => string } };
// @ts-expect-error optional reception can leave the number unchanged, so next string node is unsafe
new Sequence([optionalReception, length]);

const root = new Scene<Request, { length: number; destination: string }>().add({ sequence });
root.run = (work) => work.children.sequence.invoke(work.input);
const runner = new Runner(root, new Resources()).build();
expectType<Promise<{ length: number; destination: string }>>(runner.run({ source: 'notes', destination: 'summary' }));
// @ts-expect-error the original request contract reaches the runner
runner.run('wrong');
