import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { Invocation, InvocationContext } from '@weiliang0121/capix-invocation';
import { Scene, Resources, Runner, checkpointPoint } from '@weiliang0121/capix-runtime';

const codec = { encode: (value) => value, decode: (value) => value };
const invalidChecks = [
  ['async', async () => undefined],
  ['rejected Promise', () => Promise.reject(new Error('late check rejection'))],
  [
    'thenable',
    () => ({
      then(_resolve, reject) {
        reject(new Error('late thenable rejection'));
      },
    }),
  ],
];

function structure(check, { saved, resumed } = {}) {
  const point = checkpointPoint()({
    name: 'ready',
    state: codec,
    references: {},
    ...(check ? { check } : {}),
    resume: {
      deps: {},
      run: () => {
        resumed?.();
        return 'restored';
      },
    },
  });
  return new Scene({
    checkpoint: { key: 'test.synchronous-point-check', version: 1, input: codec, output: codec, points: [point] },
    run(work) {
      work.checkpoint({ point, state: { cursor: 1 } });
      saved?.();
      return 'completed';
    },
  });
}

function countedStore() {
  const store = new MemoryCheckpointStore();
  const counts = { saves: 0, finishes: 0 };
  return {
    store,
    counts,
    port: {
      read: (id) => store.read(id),
      save(image, revision) {
        counts.saves++;
        return store.save(image, revision);
      },
      finish(id, revision, delivery) {
        counts.finishes++;
        return store.finish(id, revision, delivery);
      },
    },
  };
}

for (const [name, invalidCheck] of invalidChecks) {
  test(`author point.check returning ${name} is rejected before a hot save`, async () => {
    const { port, counts } = countedStore();
    let checks = 0;
    let advanced = 0;
    const scene = structure(
      () => {
        checks++;
        return invalidCheck();
      },
      { saved: () => advanced++ },
    );
    const runner = new Runner(scene, new Resources(), undefined, { checkpoints: { store: port } }).build();
    await assert.rejects(runner.run({ query: 'input' }), /synchron|thenable|asynchron/i);
    assert.equal(checks, 1);
    assert.equal(advanced, 0);
    assert.deepEqual(counts, { saves: 0, finishes: 0 });
    assert.equal(runner.isRunning, false);
  });

  test(`author point.check returning ${name} is rejected before cold resume`, async () => {
    const journal = new MemoryCheckpointStore();
    let savedImage;
    const seedPort = {
      read: (id) => journal.read(id),
      save(image, revision) {
        const receipt = journal.save(image, revision);
        savedImage = journal.read(receipt.contextId).image;
        return receipt;
      },
      finish: (id, revision, delivery) => journal.finish(id, revision, delivery),
    };
    await new Runner(structure(), new Resources(), undefined, { checkpoints: { store: seedPort } }).build().run({ query: 'input' });
    const { port, store, counts } = countedStore();
    store.save(structuredClone(savedImage), 0);
    const id = savedImage.frame.owner.contextId;
    const baseline = store.read(id);
    let checks = 0;
    let resumed = 0;
    const scene = structure(
      () => {
        checks++;
        return invalidCheck();
      },
      { resumed: () => resumed++ },
    );
    const runner = new Runner(scene, new Resources(), undefined, { checkpoints: { store: port } }).build();
    await assert.rejects(runner.resume(id), /synchron|thenable|asynchron/i);
    assert.equal(checks, 1);
    assert.equal(resumed, 0);
    assert.deepEqual(counts, { saves: 0, finishes: 0 });
    assert.deepEqual(store.read(id), baseline, 'a rejected restore does not advance or close the persisted head');
    assert.equal(runner.isRunning, false);
  });
}

test('low-level checkpoint checks also reject thenables before calling Store', async () => {
  const { port, counts } = countedStore();
  const context = new InvocationContext(null);
  const call = new Invocation({
    context,
    signal: new AbortController().signal,
    identity: { contextId: context.id, kind: 'node' },
    checkpoints: { store: port },
    work: {
      checkpoint: {
        key: 'test.low-level-synchronous-check',
        version: 1,
        input: codec,
        output: codec,
        points: { ready: { state: codec, check: async () => undefined, execute: () => assert.fail('not restoring') } },
      },
      execute(_context, invocation) {
        invocation.checkpointWriter.save('ready', null);
        return 'unreachable';
      },
    },
  });
  await assert.rejects(call.run(), /synchron|thenable|asynchron/i);
  assert.deepEqual(counts, { saves: 0, finishes: 0 });
});
