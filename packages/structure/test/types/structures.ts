import { Group, Node, Scene, checkpointPoint, childReference, reception, defineGroup, defineNode, defineScene, type CallableInput, type CallableOutput, type CallableDelta, type CheckpointCodec, type ChildReference, type NodeWork } from '@weiliang0121/capix-structure';
import { type ResourceRequest } from '@weiliang0121/capix-resources';
declare function expectType<Value>(value: Value): void;
interface Input {
  readonly path: string;
}
interface Result {
  readonly text: string;
}
interface Files {
  read(path: string): string;
}
declare const files: ResourceRequest<Files>;
declare const count: ResourceRequest<number>;
declare const inputCodec: CheckpointCodec<Input>;
declare const resultCodec: CheckpointCodec<Result>;
declare const numberCodec: CheckpointCodec<number>;
const read = new Node<Input, Result, { files: Files }>({
  deps: { files },
  run(work) {
    expectType<Input>(work.input);
    // @ts-expect-error wrong resource operation argument
    work.resources.files.read(42);
    // @ts-expect-error unrequested resource
    work.resources.count;
    // @ts-expect-error leaf has no members
    work.children;
    return { text: work.resources.files.read(work.input.path) };
  },
});
// @ts-expect-error annotations cannot manufacture resource supply
new Node<Input, Result>({ run: (work: NodeWork<Input, Result, { files: Files }>) => ({ text: work.resources.files.read(work.input.path) }) });
const length = new Node<number, number>({ run: (work) => work.input });
const group = new Group<Input, Result>().add({ read, length });
const scene = new Scene<Input, Result>().add({ group });
// @ts-expect-error Node cannot add members
read.add(length);
// @ts-expect-error Scene is not a child kind
group.add(scene);
// @ts-expect-error configuration alone is not a structure
scene.add({ run: () => ({ text: '' }) });
const invalidLeaf = { members: [length], run: () => ({ text: '' }) };
// @ts-expect-error leaf position refusal holds beyond excess property checks
new Node<Input, Result>(invalidLeaf);
group.run = async (work) => {
  expectType<Promise<Result>>(work.children.read.invoke(work.input));
  // @ts-expect-error actual child input remains exact
  work.children.read.invoke({ path: 42 });
  expectType<Promise<number>>(work.children.length.invoke(2));
  return work.children.read.invoke(work.input);
};
scene.run = (work) => work.children.group.invoke(work.input);
const value = reception(read, {
  check(candidate: unknown): number {
    if (typeof candidate !== 'number') throw new Error('number');
    return candidate;
  },
  encode: (candidate) => candidate,
  decode(candidate) {
    if (typeof candidate !== 'number') throw new Error('number');
    return candidate;
  },
});
const waiting = checkpointPoint<'group', Input, Result>()({
  name: 'waiting',
  state: numberCodec,
  references: { pending: childReference(read) },
  resume: {
    uses: [read],
    deps: { count },
    async run(work, state, saved) {
      expectType<number>(state);
      expectType<number>(work.resources.count);
      expectType<ChildReference<typeof read>>(saved.pending);
      return work.children.resume(saved.pending).invoke();
    },
  },
});
const wrongInputPoint = checkpointPoint<'group', number, Result>()({ name: 'wrong-input', state: numberCodec, references: {}, resume: { run: (work) => ({ text: String(work.input) }) } });
group.checkpoint = { key: 'structures', version: 1, input: inputCodec, output: resultCodec, points: [waiting], receptions: [value] };
group.run = async (work) => {
  const child = work.children.create(read, work.input);
  work.checkpoint?.({ point: waiting, state: 1, refs: { pending: child.ref } });
  // @ts-expect-error wrong state
  work.checkpoint?.({ point: waiting, state: 'bad', refs: { pending: child.ref } });
  // @ts-expect-error wrong point owner
  work.checkpoint?.({ point: wrongInputPoint, state: 1 });
  const accepted = await child.invoke({ reception: value, result: { succeeded: (result) => result.text.length } });
  expectType<number>(accepted);
  // @ts-expect-error reception cannot be reinferred from callback
  child.invoke({ reception: value, result: { succeeded: (result) => result.text } });
  // @ts-expect-error saved child output routing was fixed at creation
  child.invoke({ delta: () => {} });
  return { text: String(accepted) };
};
// @ts-expect-error CP point registration retains owner I/O
group.checkpoint = { key: 'bad', version: 1, input: inputCodec, output: resultCodec, points: [wrongInputPoint] };
// @ts-expect-error CP owner kind remains exact
scene.checkpoint = { key: 'bad', version: 1, input: inputCodec, output: resultCodec, points: [waiting] };
const streamed = new Node<Input, Result, {}, string>();
streamed.output = { result: () => ({ text: 'result' }), delta: (value) => String(value) };
streamed.run = (work) => {
  work.output.emit('preview');
  // @ts-expect-error delta type remains string
  work.output.emit(42);
  return { text: work.input.path };
};
// @ts-expect-error output cannot change delta type
streamed.output = { result: () => ({ text: 'result' }), delta: () => 42 };
const factoryNode = defineNode<Input, Result>()({ run: (work) => ({ text: work.input.path }) });
const factoryGroup = defineGroup<Input, Result>()({ members: [factoryNode], run: (work) => work.children.invoke(factoryNode, work.input) });
const factoryScene = defineScene<Input, Result>()({ members: [factoryGroup], run: (work) => work.children.invoke(factoryGroup, work.input) });
expectType<Node<Input, Result>>(factoryNode);
expectType<Group<Input, Result>>(factoryGroup);
expectType<Scene<Input, Result>>(factoryScene);
const differentInput = new Node<number, Result>();
const narrowerInput = new Node<{ path: 'exact.md' }, Result>();
const differentOutput = new Node<Input, number>();
const differentKind = new Group<Input, Result>();
const differentDelta = new Node<Input, Result, {}, string>();
checkpointPoint<'group', Input, Result>()({
  name: 'boundary',
  state: numberCodec,
  references: { input: childReference(differentInput), narrow: childReference(narrowerInput), output: childReference(differentOutput), kind: childReference(differentKind), delta: childReference(differentDelta) },
  resume: {
    uses: [read],
    run(work, _state, saved) {
      // @ts-expect-error input mismatch
      work.children.resume(saved.input);
      // @ts-expect-error narrower input cannot substitute
      work.children.resume(saved.narrow);
      // @ts-expect-error output mismatch
      work.children.resume(saved.output);
      // @ts-expect-error kind mismatch
      work.children.resume(saved.kind);
      // @ts-expect-error delta mismatch
      work.children.resume(saved.delta);
      return { text: '' };
    },
  },
});
const streamingOwner = new Group<Input, Result, {}, string>().add({ streamed });
streamingOwner.run = (work) =>
  work.children.streamed.invoke(work.input, {
    delta(value) {
      expectType<CallableDelta<typeof streamed>>(value);
      work.output.emit(value);
      // @ts-expect-error streamed delta cannot be number
      expectType<number>(value);
    },
  });
