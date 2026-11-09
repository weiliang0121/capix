// Run from an independent directory containing the installed npm tarballs.
import assert from 'node:assert/strict';
import * as contracts from '@weiliang0121/capix-contracts';
import * as diagnostics from '@weiliang0121/capix-diagnostics';
import * as invocation from '@weiliang0121/capix-invocation';
import * as structure from '@weiliang0121/capix-structure';
import * as structureConstruction from '@weiliang0121/capix-structure/construction';
import * as runtime from '@weiliang0121/capix-runtime';
import * as construction from '@weiliang0121/capix-runtime/construction';
import * as recording from '@weiliang0121/capix-runtime/recording';
import { Resource, ResourceOffer, ResourceAccessClosed } from '@weiliang0121/capix-resources';
import { receiveOperation } from '@weiliang0121/capix-resources/operation';
import { MemoryCheckpointStore, cloneCheckpointHead } from '@weiliang0121/capix-checkpoint';

const { Scene, Group, Node, Runner, Resources, checkpointPoint } = runtime;
const { RuntimeError, StableValueError, stableValue } = contracts;
const { PersistenceError } = diagnostics;

// Separate minified entry points must retain shared class and declaration identity.
for (const entry of [diagnostics, invocation, runtime]) assert.equal(entry.RuntimeError, RuntimeError);
for (const entry of [invocation, runtime]) assert.equal(entry.PersistenceError, PersistenceError);
for (const name of ['Scene', 'Group', 'Node', 'Callable']) assert.equal(runtime[name], structure[name]);
for (const entry of [construction, recording]) {
  assert.ok(Object.keys(entry).length > 0);
  for (const [name, value] of Object.entries(entry)) assert.equal(runtime[name], value, `runtime/${name} identity`);
}
assert.equal(construction.Invocation, invocation.Invocation);
assert.equal(typeof structureConstruction.assertStructureConfigurable, 'function');
const configurable = new Scene({ run: () => null });
structureConstruction.assertStructureConfigurable(configurable);
new Runner(configurable, new Resources()).build();
assert.throws(() => structureConstruction.assertStructureConfigurable(configurable));
assert.equal(await receiveOperation({ status: 'succeeded', value: 2 }, { result: { succeeded: (value) => value * 3 } }), 6);
assert.equal(new RuntimeError('SMOKE', 'runtime error').name, 'RuntimeError');
assert.equal(new PersistenceError('smoke.commit', new Error('cause')).name, 'PersistenceError');
assert.ok(new PersistenceError('smoke.commit', null) instanceof RuntimeError);
assert.throws(() => stableValue(new Date()), StableValueError);
assert.throws(() => new invocation.InvocationContext(new Date()), StableValueError);

const offer = new ResourceOffer({
  name: 'release.dictionary',
  methods: {
    translate(origin, word, operation) {
      operation.emit(`lookup:${word}`);
      return `${origin.prefix}${word}`;
    },
  },
});
let retainedEndpoint;
const node = new Node({
  deps: { dictionary: offer.request() },
  output: { result: String, delta: String },
  run(work) {
    retainedEndpoint = work.resources.dictionary;
    return retainedEndpoint.translate(work.input, { delta: (part) => work.output.emit(part) });
  },
});
const group = new Group({ output: { result: String, delta: String } }).add({ node });
group.run = (work) => work.children.node.invoke(work.input, { delta: (part) => work.output.emit(part) });
const scene = new Scene({ output: { result: String, delta: String } }).add({ group });
scene.run = (work) => work.children.group.invoke(work.input, { delta: (part) => work.output.emit(part) });
const resources = new Resources().register(new Resource({ prefix: 'translated:' }), offer);
const runner = new Runner(scene, resources).build();
const events = [];
const unsubscribe = runner.output.subscribe({ receive: (event) => void events.push(event) });
assert.equal(await runner.run('hello'), 'translated:hello');
assert.deepEqual(
  events.map((event) => event.kind),
  ['started', 'delta', 'sealed', 'completed'],
);
assert.equal(events[1].delta, 'lookup:hello');
assert.equal(events.at(-1).result, 'translated:hello');
assert.equal(runner.isRunning, false);
unsubscribe();
await assert.rejects(retainedEndpoint.translate('late'), ResourceAccessClosed);

// The invocation's classifier must recognize errors imported by an external host.
for (const failure of [new Error('ordinary'), new PersistenceError('smoke.commit', new Error('disk')), new StableValueError('UNSUPPORTED_VALUE')]) {
  let handled = 0;
  const failingOffer = new ResourceOffer({
    methods: {
      fail() {
        throw failure;
      },
    },
  });
  const failingScene = new Scene({
    deps: { resource: failingOffer.request() },
    run: (work) =>
      work.resources.resource.fail(undefined, {
        result: {
          failed(error) {
            assert.equal(error, failure);
            handled++;
            return 'handled';
          },
        },
      }),
  });
  const failingRunner = new Runner(failingScene, new Resources().register(new Resource(null), failingOffer)).build();
  if (failure instanceof PersistenceError || failure instanceof StableValueError) {
    await assert.rejects(failingRunner.run(null), (error) => error === failure);
    assert.equal(handled, 0);
  } else {
    assert.equal(await failingRunner.run(null), 'handled');
    assert.equal(handled, 1);
  }
  assert.equal(failingRunner.isRunning, false);
}

// Capture a real save boundary before final delivery. Restore only persisted pure
// values into a fresh Store and construct an entirely new Scene and Runner.
const codec = { encode: structuredClone, decode: structuredClone };
let saved;
let bodyRuns = 0;
let resumeRuns = 0;
class CaptureStore extends MemoryCheckpointStore {
  save(image, revision) {
    const receipt = super.save(image, revision);
    saved = cloneCheckpointHead(this.read(receipt.contextId));
    return receipt;
  }
}
function checkpointRunner(store) {
  const point = checkpointPoint()({
    name: 'prepared',
    state: codec,
    references: {},
    resume: {
      run(work, state) {
        resumeRuns++;
        assert.equal(work.input.label, state.label);
        return { answer: state.answer };
      },
    },
  });
  const root = new Scene({
    checkpoint: { key: 'release.consumer', version: 1, input: codec, output: codec, points: [point] },
    run(work) {
      bodyRuns++;
      const answer = `saved:${work.input.label}`;
      work.checkpoint({ point, state: { label: work.input.label, answer }, refs: {} });
      return { answer };
    },
  });
  return new Runner(root, new Resources(), undefined, { checkpoints: { store } }).build();
}
const originalStore = new CaptureStore();
const original = checkpointRunner(originalStore);
assert.deepEqual(await original.run({ label: 'hello' }), { answer: 'saved:hello' });
assert.ok(saved);
assert.equal(saved.delivery, undefined);
assert.equal(originalStore.read(saved.image.frame.owner.contextId).delivery.status, 'succeeded');
const coldStore = new MemoryCheckpointStore();
const coldImage = cloneCheckpointHead(structuredClone(saved)).image;
coldStore.save(coldImage, 0);
const restored = checkpointRunner(coldStore);
const restoredEvents = [];
restored.output.subscribe({ receive: (event) => void restoredEvents.push(event) });
assert.deepEqual(await restored.resume(coldImage.frame.owner.contextId), { answer: 'saved:hello' });
assert.equal(bodyRuns, 1);
assert.equal(resumeRuns, 1);
assert.ok(restoredEvents.every((event) => event.contextId === coldImage.frame.owner.contextId));
assert.equal(coldStore.read(coldImage.frame.owner.contextId).delivery.status, 'succeeded');
console.log('CAPiX installed consumer smoke passed (identity, resources, invocation, cold checkpoint restore)');
