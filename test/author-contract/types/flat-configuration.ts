import { Node, Group, Scene, Runner, type Resources, type ChildCallable, defineNode, defineGroup, checkpointPoint, type NodeDefinition, type ResourceRequest, type NodeWork, type CheckpointCodec } from '@capix/server-runtime';
declare function expect<Value>(value: Value): void;
declare const count: ResourceRequest<number>;
declare const text: ResourceRequest<string>;
const node = new Node<number, string>();
node.run = (work) => String(work.input);
// @ts-expect-error run is one processing function, not a nested phase object
node.run = { deps: {}, execute: () => 'old' };
// @ts-expect-error no replacement API
node.setRun(() => 'old');
// @ts-expect-error no replacement API
node.setDefinition({ run: () => 'old' });
// @ts-expect-error no per-node normal reception phase
node.accept = () => 'old';
// @ts-expect-error no independent exception interpreter
node.exceptions = { accepts: [], handle: () => 'old' };
// @ts-expect-error a run callback cannot change input
node.run = (work: { input: string }) => work.input;
// @ts-expect-error a run callback cannot change output
node.run = () => 1;
const explicit = new Node<number, string, { count: number }>();
explicit.deps = { count };
explicit.run = (work) => {
  expect<number>(work.resources.count);
  // @ts-expect-error resource requests remain precise
  work.resources.text;
  // @ts-expect-error leaf has no child calls
  work.children;
  // @ts-expect-error ordinary processing has no framework retry rounds
  work.round;
  // @ts-expect-error ordinary processing has no framework continuation
  work.continuation;
  // @ts-expect-error ordinary processing has no initial-input alias
  work.initialInput;
  return String(work.input + work.resources.count);
};
// @ts-expect-error wrong registered resource type
explicit.deps = { count: text };
// @ts-expect-error declared constructor resources require their actual requests
const missing: NodeDefinition<number, string, { count: number }> = { run: () => '' };
// @ts-expect-error annotation cannot invent undeclared dependencies
node.run = (work: NodeWork<number, string, { count: number }>) => String(work.resources.count);
const constructor = new Node<number, string, { count: number }>({ deps: { count }, run: (work) => String(work.resources.count) });
const inferred = new Node({ deps: { count }, run: (work) => String(work.resources.count) });
const leaf = defineNode<number, string>()({ deps: { count }, run: (work) => String(work.resources.count) });
const other = defineNode<string, number>()({ run: (work) => work.input.length });
const group = new Group<number, string>().add({ leaf, other });
group.run = async (work) => {
  expect<Promise<string>>(work.children.leaf.invoke(work.input));
  expect<Promise<number>>(work.children.other.invoke('text'));
  // @ts-expect-error member call input stays number
  work.children.leaf.invoke('bad');
  return work.children.leaf.invoke(work.input, { result: { succeeded: (value) => value, failed: () => '' } });
};
const factory = defineGroup<number, string>()({ members: [leaf], deps: { count }, run: (work) => work.children.invoke(leaf, work.resources.count) });
const streamed = defineNode<number, string>()({
  output: { result: (value) => String(value), delta: (value) => String(value) },
  run(work) {
    work.output.emit('preview');
    // @ts-expect-error output delta remains string
    work.output.emit(1);
    return String(work.input);
  },
});
declare const numberCodec: CheckpointCodec<number>;
declare const stringCodec: CheckpointCodec<string>;
const point = checkpointPoint<'node', number, string>()({
  name: 'saved',
  state: numberCodec,
  references: {},
  resume: {
    deps: { text },
    run(work, state) {
      expect<number>(state);
      expect<string>(work.resources.text);
      expect<1 | 2>(work.round);
      return work.resources.text;
    },
  },
});
const wrongPoint = checkpointPoint<'node', string, string>()({ name: 'wrong', state: numberCodec, references: {}, resume: { run: (work) => work.input } });
explicit.checkpoint = { key: 'flat.node', version: 1, input: numberCodec, output: stringCodec, points: [point] };
explicit.run = (work) => {
  work.checkpoint?.({ point, state: 1 });
  // @ts-expect-error state follows its codec
  work.checkpoint?.({ point, state: 'bad' });
  // @ts-expect-error checkpoint owner input remains fixed
  work.checkpoint?.({ point: wrongPoint, state: 1 });
  return String(work.resources.count);
};
// @ts-expect-error checkpoint registration retains the owner input
explicit.checkpoint = { key: 'bad', version: 1, input: numberCodec, output: stringCodec, points: [wrongPoint] };
class ReadingNode extends Node<number, string> {
  constructor() {
    super({ run: (work) => String(work.input) });
  }
}
class ReadingScene extends Scene<number, string> {
  constructor() {
    super({ run: (work) => String(work.input) });
    this.add(new ReadingNode());
  }
}
declare const resources: Resources;
const runner = new Runner(new ReadingScene(), resources);
expect<Promise<string>>(runner.run(1));
// @ts-expect-error caller input is not erased by registration
runner.run('bad');
declare const registered: ChildCallable;
// @ts-expect-error registration cannot reintroduce setters
registered.setRun(() => 'bad');
// @ts-expect-error literal objects lack structure identity
group.add({ kind: 'node', deps: {}, run: () => '' });
void [constructor, inferred, factory, streamed, missing];
