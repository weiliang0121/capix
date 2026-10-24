import { Driver, Group, Node, Scene, checkpointPoint, childReference, reception, defineGroup, defineNode, defineScene, type BuiltCallable, type CallableInput, type CallableOutput, type CallableDelta, type ResourceRequest, type CheckpointCodec, type ChildReference, type GroupDefinition, type NodeDefinition, type NodeWork, type GroupWork, type HandleWork } from '@capix/server-runtime';

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
declare const repair: ResourceRequest<{ fix(message: string): Result }>;
declare const inputCodec: CheckpointCodec<Input>;
declare const resultCodec: CheckpointCodec<Result>;
declare const numberCodec: CheckpointCodec<number>;

// Constructor resources are explicit when the caller explicitly supplies I/O.
const constructor = new Node<Input, Result, { files: Files }>({
  deps: { files },
  run(work) {
    expectType<Input>(work.input);
    const text: string = work.resources.files.read(work.input.path);
    // @ts-expect-error constructor Work does not contain an undeclared resource
    work.resources.count;
    // @ts-expect-error a Node has no child-call capability
    work.children;
    return { text };
  },
});
// @ts-expect-error an explicit resource type cannot manufacture its request
const missingConstructorRequest: NodeDefinition<Input, Result, { files: Files }> = {
  run: () => ({ text: 'missing' }),
};
void missingConstructorRequest;
new Node<Input, Result>({
  // @ts-expect-error annotating a callback cannot supply omitted constructor requests
  run: (work: NodeWork<Input, Result, { files: Files }>) => ({ text: work.resources.files.read(work.input.path) }),
});

const read = new Node<Input, Result>();
read.setRun(
  function (work) {
    expectType<Input>(work.input);
    const text: string = work.resources.files.read(work.input.path);
    // @ts-expect-error resource methods retain their argument contracts
    work.resources.files.read(42);
    // @ts-expect-error resource inference does not expose an undeclared endpoint
    work.resources.repair;
    // @ts-expect-error a Node cannot create subcalls
    work.children;
    return { text };
  },
  { files },
);
read.setRun(
  function (work) {
    expectType<number>(work.resources.count);
    // @ts-expect-error replacing run does not retain the previous resource grant
    work.resources.files;
    return { text: String(work.resources.count) };
  },
  { count },
);
read.setRun(function (work) {
  // @ts-expect-error omitted requests leave this phase empty
  work.resources.count;
  return { text: work.input.path };
});
read.setRun(
  // @ts-expect-error the structure output cannot be changed by replacing run
  () => 123,
);
read.setRun(
  // @ts-expect-error the structure input cannot be changed by replacing run
  (work: { input: number }) => ({ text: String(work.input) }),
);
read.setRun(
  // @ts-expect-error an annotated callback cannot introduce an unrequested endpoint
  (work: NodeWork<Input, Result, { files: Files }>) => ({ text: work.resources.files.read(work.input.path) }),
);

const length = new Node<number, number>({ run: (work) => work.input });
const group = new Group<Input, Result>();
const scene = new Scene<Input, Result>();
expectType<typeof group>(group.add(read, length));
expectType<typeof scene>(scene.add(group, read));
// @ts-expect-error leaf structures do not provide add
read.add(length);
// @ts-expect-error a Scene cannot be added below a Group
group.add(scene);
// @ts-expect-error a Scene cannot be added below another Scene
scene.add(scene);
// @ts-expect-error a plain configuration is not a registered structure
group.add({ run: () => ({ text: 'configuration' }) });

const illegalLeafConfiguration = { members: [length], run: () => ({ text: 'invalid' }) };
// @ts-expect-error Node constructors reject members beyond excess-property checks
new Node<Input, Result>(illegalLeafConfiguration);
// @ts-expect-error Node setters reject members beyond excess-property checks
read.setDefinition(illegalLeafConfiguration);

group.setRun(
  async function (work) {
    expectType<number>(work.resources.count);
    const child = work.children.create(read, work.input);
    expectType<Promise<Result>>(child.run());
    // @ts-expect-error a child keeps its actual input signature
    work.children.create(read, { path: 42 });
    // @ts-expect-error registered membership does not enlarge this stage's uses
    work.children.create(length, 2);
    await child.run();
    return child.accept();
  },
  { count },
  { uses: [read] },
);
group.setRun(
  function (work) {
    // @ts-expect-error an explicit empty uses list grants no new calls
    work.children.create(read, work.input);
    return { text: work.input.path };
  },
  {},
  { uses: [] },
);
group.setRun(
  // Existing ChildCalls generic-method variance does not reject this explicit
  // annotation. The installed phase still rejects the actual create at runtime.
  (work: GroupWork<Input, Result, {}, typeof read>) => work.children.create(read, work.input).run(),
  {},
  { uses: [] },
);
// Without uses, run retains the existing all-installed-members behavior.
group.setRun(async function (work) {
  const child = work.children.create(read, work.input);
  await child.run();
  return child.accept();
});

group.setDefinition({
  deps: { files },
  uses: [read],
  async run(work) {
    expectType<string>(work.resources.files.read(work.input.path));
    // @ts-expect-error exception requests do not become normal-phase resources
    work.resources.repair;
    const child = work.children.create(read, work.input);
    await child.run();
    return child.accept();
  },
  exceptions: {
    deps: { repair },
    accepts: [],
    uses: [length],
    handle(work) {
      expectType<Promise<number>>(work.children.create(length, 2).run());
      // @ts-expect-error normal-phase resources do not become handler resources
      work.resources.files;
      // @ts-expect-error normal-phase actions do not become handler actions
      work.children.create(read, work.input);
      return work.return(work.resources.repair.fix('repair'));
    },
  },
});
group.setDefinition({
  run: (work) => ({ text: work.input.path }),
  exceptions: {
    accepts: [],
    handle(work) {
      // @ts-expect-error exception actions default to none when uses is omitted
      work.children.create(read, work.input);
      return work.unhandled;
    },
  },
});
group.setDefinition({
  run: (work) => ({ text: work.input.path }),
  exceptions: {
    accepts: [],
    // @ts-expect-error handler annotations cannot invent an undeclared resource request
    handle: (work: HandleWork<'group', Input, Result, { repair: { fix(message: string): Result } }, never>) => work.return(work.resources.repair.fix('repair')),
  },
});
group.setDefinition({
  // @ts-expect-error complete replacement cannot redefine the output signature
  run: () => 1,
});

const constructorDefinition: GroupDefinition<Input, Result, { files: Files }, { repair: { fix(message: string): Result } }> = {
  deps: { files },
  run: (work) => ({ text: work.resources.files.read(work.input.path) }),
  exceptions: {
    deps: { repair },
    accepts: [],
    handle: (work) => work.return(work.resources.repair.fix('repair')),
  },
};
new Group(constructorDefinition);
new Group<Input, Result>({
  run: (work) => ({ text: work.input.path }),
  exceptions: {
    accepts: [],
    uses: [read],
    handle(work) {
      expectType<Input>(work.input);
      expectType<Promise<Result>>(work.children.create(read, work.input).run());
      // @ts-expect-error constructor exception actions preserve child input contracts
      work.children.create(read, 1);
      return work.unhandled;
    },
  },
}).add(read);
new Group<Input, Result>({
  run: (work) => ({ text: work.input.path }),
  exceptions: {
    accepts: [],
    handle(work) {
      expectType<Input>(work.input);
      // Constructors check child kind and I/O, not the exact uses list.
      // An omitted exception uses list still grants no actions at runtime.
      work.children.create(read, work.input);
      return work.unhandled;
    },
  },
}).add(read);

const value = reception(read, {
  check: (candidate: unknown): number => {
    if (typeof candidate !== 'number') throw new Error('number expected');
    return candidate;
  },
  encode: (candidate) => candidate,
  decode: (candidate) => {
    if (typeof candidate !== 'number') throw new Error('number expected');
    return candidate;
  },
});
group.setDefinition({
  receptions: [value],
  uses: [read],
  async run(work) {
    const child = work.children.create(read, work.input);
    await child.run();
    const accepted = await child.accept(value, (result) => result.text.length);
    expectType<number>(work.children.facts.accepted(child.ref, value));
    // @ts-expect-error the reception value cannot be inferred from the callback instead
    child.accept(value, (result) => result.text);
    return { text: String(accepted) };
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
      const child = work.children.resume(saved.pending);
      await child.run();
      return child.accept();
    },
  },
});
const wrongInputPoint = checkpointPoint<'group', number, Result>()({
  name: 'wrong-input',
  state: numberCodec,
  references: {},
  resume: { run: (work) => ({ text: String(work.input) }) },
});
group.setDefinition({
  checkpoint: { key: 'structures.types', version: 1, input: inputCodec, output: resultCodec, points: [waiting] },
  uses: [read],
  async run(work) {
    const child = work.children.create(read, work.input);
    work.checkpoint?.({ point: waiting, state: 1, refs: { pending: child.ref } });
    // @ts-expect-error checkpoint state keeps its codec-derived type
    work.checkpoint?.({ point: waiting, state: 'wrong', refs: { pending: child.ref } });
    // @ts-expect-error a checkpoint point cannot belong to a different owner input
    work.checkpoint?.({ point: wrongInputPoint, state: 1, refs: {} });
    await child.run();
    return child.accept();
  },
});
group.setDefinition({
  // @ts-expect-error registering a point also preserves its owner I/O
  checkpoint: { key: 'wrong-input', version: 1, input: inputCodec, output: resultCodec, points: [wrongInputPoint] },
  run: () => ({ text: 'never' }),
});
scene.setDefinition({
  // @ts-expect-error checkpoint owner kind cannot change from Group to Scene
  checkpoint: { key: 'wrong-kind', version: 1, input: inputCodec, output: resultCodec, points: [waiting] },
  run: () => ({ text: 'never' }),
});

const streamed = new Node<Input, Result, {}, {}, string>();
streamed.setDefinition({
  output: { result: () => ({ text: 'result' }), delta: (candidate) => String(candidate) },
  run(work) {
    work.output.emit('delta');
    // @ts-expect-error the structure Delta stays fixed after configuration
    work.output.emit(42);
    return { text: work.input.path };
  },
});
streamed.setDefinition({
  // @ts-expect-error output configuration cannot change the structure Delta
  output: { result: () => ({ text: 'result' }), delta: () => 42 },
  run: () => ({ text: 'result' }),
});

const factoryNode = defineNode<Input, Result>()({ run: (work) => ({ text: work.input.path }) });
const factoryGroup = defineGroup<Input, Result>()({ members: [factoryNode], run: (work) => work.children.create(factoryNode, work.input).run() });
const factoryScene = defineScene<Input, Result>()({ members: [factoryGroup], run: (work) => work.children.create(factoryGroup, work.input).run() });
expectType<Node<Input, Result>>(factoryNode);
expectType<Group<Input, Result>>(factoryGroup);
expectType<Scene<Input, Result>>(factoryScene);
factoryNode.setRun((work) => ({ text: work.input.path }));
factoryGroup.add(read);
factoryScene.add(group);

const driver = new Driver();
const bound = driver.build(group, { providers: [], source: { capture: () => null } });
expectType<Promise<Result>>(driver.run(bound, { path: 'notes.md' }, {}));
// @ts-expect-error bound inputs are fixed by the structure rather than the latest phase resources
driver.run(bound, 123, {});
// @ts-expect-error bound outputs cannot be changed by a surrounding annotation
const incorrectOutput: Promise<number> = driver.run(bound, { path: 'notes.md' }, {});
void [constructor, incorrectOutput];

// Build is a facet on the original object. Relation contracts compare its stable
// kind/I/O/Delta signature, not the newly installed runtime-capability marker.
declare const builtRead: BuiltCallable<typeof read, { tenantId: string }>;
declare const originalReadRef: ChildReference<typeof read>;
declare const builtReadRef: ChildReference<typeof builtRead>;
const sameRead: typeof read = builtRead;
expectType<Input>({ path: 'notes.md' } satisfies CallableInput<typeof builtRead>);
expectType<Result>({ text: 'read' } satisfies CallableOutput<typeof builtRead>);
const relationOwner = new Group<Input, Result>();
relationOwner.add(read);
relationOwner.setDefinition({
  receptions: [value],
  uses: [builtRead],
  async run(work) {
    const fromOriginal = work.children.create(read, work.input);
    const fromBuilt = work.children.create(builtRead, work.input);
    await fromOriginal.run();
    await fromBuilt.run();
    const originalValue: number = await fromOriginal.accept(value, (result) => result.text.length);
    const builtValue: number = await fromBuilt.accept(value, (result) => result.text.length);
    expectType<number>(work.children.facts.accepted(originalReadRef, value));
    expectType<number>(work.children.facts.accepted(builtReadRef, value));
    // @ts-expect-error A build facet does not weaken the reception value contract.
    fromBuilt.accept(value, (result) => result.text);
    // @ts-expect-error A build facet does not change the child's input.
    work.children.create(builtRead, { path: 42 });
    return { text: String(originalValue + builtValue) };
  },
});
const builtPoint = checkpointPoint<'group', Input, Result>()({
  name: 'built-facets',
  state: numberCodec,
  references: { original: childReference(read), built: childReference(builtRead) },
  resume: {
    uses: [builtRead],
    async run(work, _state, saved) {
      const original = work.children.resume(saved.original);
      const built = work.children.resume(saved.built);
      expectType<Promise<Result>>(original.run());
      expectType<Promise<Result>>(built.run());
      await original.run();
      await built.run();
      const accepted: number = await built.accept(value, (result) => result.text.length);
      return { text: String(accepted) };
    },
  },
});
relationOwner.setDefinition({
  checkpoint: { key: 'built.facets', version: 1, input: inputCodec, output: resultCodec, points: [builtPoint] },
  receptions: [value],
  uses: [read],
  async run(work) {
    const child = work.children.create(builtRead, work.input);
    work.checkpoint?.({ point: builtPoint, state: 1, refs: { original: child.ref, built: builtReadRef } });
    await child.run();
    return child.accept();
  },
});

const differentInput = new Node<number, Result>();
const narrowerInput = new Node<{ path: 'exact.md' }, Result>();
const differentOutput = new Node<Input, number>();
const differentKind = new Group<Input, Result>();
const differentDelta = new Node<Input, Result, {}, {}, string>();
const rejectedBuildFacets = checkpointPoint<'group', Input, Result>()({
  name: 'rejected-built-facets',
  state: numberCodec,
  references: {
    input: childReference(differentInput),
    narrow: childReference(narrowerInput),
    output: childReference(differentOutput),
    kind: childReference(differentKind),
    delta: childReference(differentDelta),
  },
  resume: {
    uses: [builtRead],
    run(work, _state, saved) {
      // @ts-expect-error Stable identity does not erase the input signature.
      work.children.resume(saved.input);
      // @ts-expect-error A narrower input cannot substitute for the installed callable.
      work.children.resume(saved.narrow);
      // @ts-expect-error Stable identity does not erase the output signature.
      work.children.resume(saved.output);
      // @ts-expect-error Stable identity does not erase the structural kind.
      work.children.resume(saved.kind);
      // @ts-expect-error Stable identity does not erase the output Delta.
      work.children.resume(saved.delta);
      return { text: 'type-only' };
    },
  },
});

// Streaming callbacks use the same Delta before and after runtime assembly.
declare const builtStreamed: BuiltCallable<typeof streamed, { tenantId: string }>;
const streamedOwner = new Group<Input, Result, {}, {}, string>();
streamedOwner.add(streamed);
streamedOwner.setRun(
  async function (work) {
    const child = work.children.create(streamed, work.input, {
      output: {
        receive(event) {
          if (event.kind === 'delta') {
            expectType<CallableDelta<typeof builtStreamed>>(event.delta);
            work.output.emit(event.delta);
            // @ts-expect-error Streaming Delta stays string after assembly.
            expectType<number>(event.delta);
          }
        },
      },
    });
    await child.run();
    return child.accept();
  },
  {},
  { uses: [builtStreamed] },
);
void [sameRead, rejectedBuildFacets];
