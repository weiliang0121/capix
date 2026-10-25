import { Node, Group, Scene, Runner, type Resources, type ChildCallable, defineNode, defineGroup, checkpointPoint, type NodeDefinition, type ResourceRequest, type NodeWork, type HandleWork, type CheckpointCodec } from '@capix/server-runtime';

declare function expect<Value>(value: Value): void;
declare const count: ResourceRequest<number>;
declare const text: ResourceRequest<string>;
const node = new Node<number, string>();
expect<((work: NodeWork<number, string, object>) => string | Promise<string>) | undefined>(node.run);
expect<object>(node.deps);
// @ts-expect-error structures retain the same flat processing shape as their configuration
node.run = { deps: {}, execute: () => 'old' };
// @ts-expect-error processing does not expose a nested phase object
node.run?.execute;
node.setRun(
  (work) => {
    expect<number>(work.input);
    expect<number>(work.resources.count);
    // @ts-expect-error unrequested endpoint
    work.resources.text;
    // @ts-expect-error leaf has no child calls
    work.children;
    return String(work.resources.count + work.input);
  },
  { count },
);
node.setRun(
  (work) => {
    // @ts-expect-error replacement does not preserve previous grant
    work.resources.count;
    return String(work.resources.text);
  },
  { text },
);
node.setRun((work) => {
  // @ts-expect-error no dependencies granted
  work.resources.count;
  return String(work.input);
});
// @ts-expect-error cannot infer resources from annotated callback
node.setRun((work: NodeWork<number, string, { count: number }>) => String(work.resources.count));
// @ts-expect-error explicit nonempty dependency type requires actual requests
node.setRun<{ count: ResourceRequest<number> }>((work) => String(work.resources.count));
// @ts-expect-error setter cannot change output
node.setRun(() => 3);
// @ts-expect-error setter cannot change input
node.setRun((work: { input: string }) => work.input);
// @ts-expect-error old nested run API is no longer public
node.setRun({ execute: () => 'old' });
const constructor = new Node<number, string, { count: number }>({
  deps: { count },
  run(work) {
    expect<number>(work.resources.count);
    // @ts-expect-error undeclared request
    work.resources.text;
    return String(work.input + work.resources.count);
  },
});
// @ts-expect-error explicit resources cannot omit requests
const missing: NodeDefinition<number, string, { count: number }> = { run: () => 'missing' };
new Node<number, string>({
  // @ts-expect-error nested constructor phase object no longer public
  run: { execute: () => 'old' },
});
const inferred = new Node({
  deps: { count },
  run(work) {
    expect<number>(work.resources.count);
    return String(work.resources.count);
  },
});
const leaf = defineNode<number, string>()({
  deps: { count },
  run(work) {
    expect<number>(work.resources.count);
    return String(work.input);
  },
});
const other = defineNode<string, number>()({ run: (work) => work.input.length });
const group = new Group<number, string>();
group.add(leaf, other);
group.setRun(
  (work) => {
    expect<number>(work.resources.count);
    expect<Promise<string>>(work.children.create(leaf, work.input).run());
    // @ts-expect-error selected child input remains number
    work.children.create(leaf, 'bad');
    // @ts-expect-error ungranted child
    work.children.create(other, 'other');
    return 'ok';
  },
  { count },
  {
    uses: [leaf],
    accept(work) {
      expect<string>(work.delivered);
      return work.continue(work.input, 'again');
    },
  },
);
group.setDefinition({
  deps: { count },
  uses: [leaf],
  run(work) {
    expect<number>(work.resources.count);
    return 'ok';
  },
  accept(work) {
    expect<string>(work.delivered);
    return work.continue(work.input, 'again');
  },
  exceptions: {
    deps: { text },
    uses: [other],
    accepts: [],
    handle(work) {
      expect<string>(work.resources.text);
      // @ts-expect-error normal deps cannot leak into handler
      work.resources.count;
      expect<Promise<number>>(work.children.create(other, 'ok').run());
      // @ts-expect-error normal uses cannot leak into handler
      work.children.create(leaf, 1);
      return work.return('handled');
    },
  },
});
group.setDefinition({
  run: () => 'ok',
  exceptions: {
    accepts: [],
    handle(work) {
      // @ts-expect-error handler grants no children by default
      work.children.create(leaf, 1);
      return work.unhandled;
    },
  },
});
group.setDefinition({
  run: () => 'ok',
  exceptions: {
    accepts: [],
    // @ts-expect-error annotations cannot invent handler deps
    handle: (work: HandleWork<'group', number, string, { text: string }, never>) => work.return(work.resources.text),
  },
});
const factory = defineGroup<number, string>()({
  members: [leaf],
  deps: { count },
  run(work) {
    expect<number>(work.resources.count);
    return work.children.create(leaf, work.input).run();
  },
});
const streamed = defineNode<number, string>()({
  output: { result: (value: unknown) => String(value), delta: (value: unknown) => String(value) },
  run(work) {
    work.output.emit('hello');
    // @ts-expect-error delta remains string
    work.output.emit(1);
    return String(work.input);
  },
});
const scene = new Scene<number, string>({ run: (work) => String(work.input) });
void [constructor, missing, inferred, factory, streamed, scene];
declare const numberCodec: CheckpointCodec<number>;
declare const stringCodec: CheckpointCodec<string>;
const point = checkpointPoint<'node', number, string>()({
  name: 'normal',
  state: numberCodec,
  references: {},
  resume: {
    deps: { text },
    run(work, state) {
      expect<string>(work.resources.text);
      expect<number>(state);
      return work.resources.text;
    },
  },
});
const wrongPoint = checkpointPoint<'node', string, string>()({ name: 'wrong', state: numberCodec, references: {}, resume: { run: (work) => work.input } });
node.setDefinition({
  deps: { count },
  checkpoint: { key: 'flat.node', version: 1, input: numberCodec, output: stringCodec, points: [point] },
  run(work) {
    work.checkpoint?.({ point: point, state: 1, refs: {} });
    // @ts-expect-error state codec still constrains save
    work.checkpoint?.({ point: point, state: 'bad', refs: {} });
    // @ts-expect-error other owner input cannot be saved
    work.checkpoint?.({ point: wrongPoint, state: 1, refs: {} });
    // @ts-expect-error resume resources do not become normal resources
    work.resources.text;
    return String(work.resources.count);
  },
});
node.setDefinition({
  // @ts-expect-error checkpoint registration retains owner IO
  checkpoint: { key: 'bad', version: 1, input: numberCodec, output: stringCodec, points: [wrongPoint] },
  run: () => 'ok',
});

// Runtime registration stores the fixed configuration surface, not author setters.
// Concrete subclasses without output deltas remain valid heterogeneous members.
class ReadingNode extends Node<number, string> {
  constructor() {
    super({ run: (work) => String(work.input) });
  }
}
class ReadingGroup extends Group<number, string> {
  constructor() {
    super({ run: (work) => String(work.input) });
    this.add(new ReadingNode());
  }
}
class ReadingScene extends Scene<number, string> {
  constructor() {
    super({ run: (work) => String(work.input) });
    this.add(new ReadingGroup());
  }
}
declare const configuredResources: Resources;
const runner = new Runner(new ReadingScene(), configuredResources);
expect<Promise<string>>(runner.run(1));
// @ts-expect-error the registry view does not erase the caller's input
runner.run('bad');
declare const registered: ChildCallable;
// @ts-expect-error heterogeneous registration does not grant configuration mutation
registered.setRun(() => 'bad');
// @ts-expect-error configuration-shaped plain objects do not have the structure signature
group.add({ kind: 'node', deps: {}, run: () => 'fake' });
