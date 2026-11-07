import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Resource, ResourceOffer } from '@capix/resources';
import { Node, Resources, Runner, Scene } from '@capix/server-runtime';

// This is a negative control using the real public runtime. Running a scene
// again with cached resource answers is NOT restoration of the original call.
test('real Runner: cached resource result alone does not replay the original invocation', async () => {
  const counts = { effects: 0, cleanups: 0, resourceReceptions: 0, childReceptions: 0 };
  const cache = new Map();
  const port = new ResourceOffer({
    methods: {
      read(origin, key, operation) {
        operation.onClose(() => {
          counts.cleanups++;
        });
        if (!origin.has(key)) {
          counts.effects++;
          origin.set(key, Object.freeze({ text: 'fixed answer' }));
        }
        return origin.get(key);
      },
    },
  });
  const child = new Node({
    deps: { data: port.request() },
    run(work) {
      return work.resources.data.read(work.input, {
        result: {
          succeeded(value) {
            counts.resourceReceptions++;
            return value;
          },
        },
      });
    },
  });
  const scene = new Scene({
    output: { result: (value) => value, delta: (value) => value },
    async run(work) {
      const value = await work.children.child.invoke(work.input, {
        result: {
          succeeded(value) {
            counts.childReceptions++;
            return { accepted: value.text };
          },
        },
      });
      work.output.emit(value.accepted);
      return value;
    },
  }).add({ child });
  const resources = new Resources().register(new Resource(cache), port);
  const runner = new Runner(scene, resources).build();
  const events = [];
  runner.output.subscribe({
    receive: (event) => {
      events.push(event);
    },
  });
  assert.deepEqual(await runner.run('request'), { accepted: 'fixed answer' });
  assert.deepEqual(await runner.run('request'), { accepted: 'fixed answer' });
  assert.deepEqual(counts, { effects: 1, cleanups: 2, resourceReceptions: 2, childReceptions: 2 });
  const deltas = events.filter((event) => event.kind === 'delta');
  assert.equal(deltas.length, 2);
  assert.notEqual(deltas[0].entryId, deltas[1].entryId);
});

test('concurrent replay: saved outcomes alone do not preserve a Promise.race winner', async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const original = Promise.race([first.promise, second.promise]);
  second.resolve('B');
  assert.equal(await original, 'B');
  first.resolve('A');
  // Both operations are completed in durable history. Injecting their saved
  // results as fulfilled promises changes the decision without redoing either.
  const replayed = await Promise.race([Promise.resolve('A'), Promise.resolve('B')]);
  assert.equal(replayed, 'A');
  // An explicit recorded winner would restore the decision; it is an extra
  // fact, not a property implied by storing the two completed results.
  const recordedDecision = Object.freeze({ winner: 'B' });
  assert.equal(recordedDecision.winner, 'B');
});

test('concurrent replay: Promise.all input ordering does not require completion ordering', async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const original = Promise.all([first.promise, second.promise]);
  second.resolve('B');
  first.resolve('A');
  const actual = await original;
  const replayed = await Promise.all([Promise.resolve('A'), Promise.resolve('B')]);
  assert.deepEqual(replayed, actual);
  assert.deepEqual(actual, ['A', 'B']);
});

test('real resource: a cached successful value does not bypass a new cleanup failure', async () => {
  const cached = Object.freeze({ text: 'already produced' });
  const cleanupFailure = new Error('required cleanup failed');
  let accepted = 0;
  const port = new ResourceOffer({
    methods: {
      read(_origin, _input, operation) {
        operation.onClose(() => {
          throw cleanupFailure;
        });
        return cached;
      },
    },
  });
  const scene = new Scene({
    deps: { data: port.request() },
    run(work) {
      return work.resources.data.read(null, {
        result: {
          succeeded(value) {
            accepted++;
            return value;
          },
        },
      });
    },
  });
  const runner = new Runner(scene, new Resources().register(new Resource(null), port)).build();
  await assert.rejects(runner.run(null));
  assert.equal(accepted, 0);
  assert.equal(cached.text, 'already produced');
});
