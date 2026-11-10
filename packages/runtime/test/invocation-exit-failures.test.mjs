import assert from 'node:assert/strict';

import { test } from 'node:test';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

import { ExceptionContract, Invocation, InvocationContext, inspectChildCallFailure } from '@weiliang0121/capix-invocation';

import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';

import { Node, Resources, Runner, Scene, checkpointPoint } from '@weiliang0121/capix-runtime';

const codec = { encode: (value) => value, decode: (value) => value };

// Check the actual error graph, including an explicitly thrown undefined; an absent cause
// must not falsely count as preserving undefined. All errors here are test-owned values.
function containsFailure(error, expected, seen = new Set()) {
  if (error === expected) return true;
  if (!(error instanceof Error) || seen.has(error)) return false;
  seen.add(error);
  if (Object.hasOwn(error, 'cause') && containsFailure(error.cause, expected, seen)) return true;
  return error instanceof AggregateError && error.errors.some((item) => containsFailure(item, expected, seen));
}

class Journal extends MemoryCheckpointStore {
  image;
  finishes = [];
  save(image, revision) {
    const receipt = super.save(image, revision);
    this.image = this.read(receipt.contextId).image;
    return receipt;
  }
  finish(contextId, revision, delivery) {
    this.finishes.push(delivery.status);
    return super.finish(contextId, revision, delivery);
  }
}

function pendingResource(cleanupFailure) {
  const response = Promise.withResolvers();
  const cleanup = [];
  let pending;
  const offer = new ResourceOffer({
    methods: {
      read(_source, _input, operation) {
        operation.onClose(() => {
          cleanup.push('first');
          throw cleanupFailure;
        });
        operation.onClose(() => {
          cleanup.push('second');
        });
        return response.promise;
      },
    },
  });
  return {
    offer,
    cleanup,
    start(endpoint) {
      pending = endpoint.read();
      void pending.catch(() => undefined);
    },
    async finish() {
      response.resolve('late result');
      await pending?.catch(() => undefined);
    },
  };
}

async function checkpointedRunner(mode, pending, run) {
  const deps = { probe: pending.offer.request() };
  const resources = new Resources().register(new Resource(null), pending.offer);
  function scene(seed) {
    const point = checkpointPoint()({ name: 'ready', state: codec, references: {}, resume: { deps, run } });
    return new Scene({
      deps,
      checkpoint: { key: 'test.exit-failures', version: 1, input: codec, output: codec, points: [point] },
      run(work) {
        work.checkpoint({ point, state: null });
        return seed ? 'seed' : run(work);
      },
    });
  }
  const store = new Journal();
  if (mode === 'normal') {
    const runner = new Runner(scene(false), resources, undefined, { checkpoints: { store } }).build();
    return { runner, store, start: () => runner.run(null) };
  }
  const seed = new Journal();
  await new Runner(scene(true), resources, undefined, { checkpoints: { store: seed } }).build().run(null);
  store.save(structuredClone(seed.image), 0);
  const runner = new Runner(scene(false), resources, undefined, { checkpoints: { store } }).build();
  return { runner, store, start: () => runner.resume(store.image.frame.owner.contextId) };
}

// Only probes local exclusion. Reusing this ID is not a business replay or CP resume.
async function assertClaimReleased(store, contextId) {
  const context = new InvocationContext(null);
  context.installIdentity(contextId);
  const probe = new Invocation({ context, signal: new AbortController().signal, checkpoints: { store }, work: { execute: () => 'released' } });
  assert.equal(await probe.run(), 'released');
}

for (const mode of ['normal', 'resume']) {
  for (const body of ['succeeded', 'error', 'undefined']) {
    test(`${mode} preserves ${body} body and resource cleanup failure without publishing CP success`, async (t) => {
      const original = body === 'undefined' ? undefined : new Error('body failed');
      const cleanup = new Error('cleanup failed');
      const pending = pendingResource(cleanup);
      t.after(() => pending.finish());
      const harness = await checkpointedRunner(mode, pending, (work) => {
        pending.start(work.resources.probe);
        if (body !== 'succeeded') throw original;
        return 'body result';
      });
      await assert.rejects(harness.start(), (error) => {
        assert.ok(containsFailure(error, cleanup), 'cleanup failure must remain diagnosable');
        if (body !== 'succeeded') assert.ok(containsFailure(error, original), 'the original thrown value must survive cleanup');
        return true;
      });
      assert.deepEqual(pending.cleanup, ['first', 'second']);
      assert.equal(harness.runner.isRunning, false);
      assert.equal(harness.store.read(harness.store.image.frame.owner.contextId).delivery.status, 'failed');
      assert.equal(harness.store.finishes.includes('succeeded'), false);
      await assertClaimReleased(harness.store, harness.store.image.frame.owner.contextId);
    });
  }
}

test('a resource cleanup failure cannot become a parent business fallback', async (t) => {
  const cleanup = new Error('cleanup failed');
  const pending = pendingResource(cleanup);
  t.after(() => pending.finish());
  let handled = false;
  const child = new Node({
    deps: { probe: pending.offer.request() },
    run(work) {
      pending.start(work.resources.probe);
      return 'candidate';
    },
  });
  const scene = new Scene({
    run(work) {
      return work.children.child.invoke(null, {
        result: {
          failed() {
            handled = true;
            return 'fallback';
          },
        },
      });
    },
  }).add({ child });
  const runner = new Runner(scene, new Resources().register(new Resource(null), pending.offer)).build();
  await assert.rejects(runner.run(null), (error) => containsFailure(error, cleanup));
  assert.equal(handled, false);
  assert.equal(runner.isRunning, false);
  assert.deepEqual(pending.cleanup, ['first', 'second']);
});

test('a sourced child reception failure survives a separate local cleanup failure', async (t) => {
  const rejected = new ExceptionContract('EXIT_RECEPTION_FAILED').create('receiver failed', {});
  const cleanup = new Error('cleanup failed');
  const pending = pendingResource(cleanup);
  t.after(() => pending.finish());
  let source;
  let handled = false;
  const child = new Node({ run: () => 'child result' });
  const scene = new Scene({
    deps: { probe: pending.offer.request() },
    async run(work) {
      pending.start(work.resources.probe);
      try {
        return await work.children.child.invoke(null, {
          result: {
            succeeded() {
              throw rejected;
            },
            failed() {
              handled = true;
              return 'invalid fallback';
            },
          },
        });
      } catch (error) {
        source = inspectChildCallFailure(error);
        assert.equal(source?.exception, rejected);
        assert.equal(source.origin.kind, 'child-reception');
        const fact = work.children.facts.list(child)[0];
        assert.equal(source.origin.child.parentRound, fact.parentRound);
        assert.equal(source.origin.child.order, fact.order);
        assert.equal(fact.reception.status, 'failed');
        throw error;
      }
    },
  }).add({ child });
  const runner = new Runner(scene, new Resources().register(new Resource(null), pending.offer)).build();
  await assert.rejects(runner.run(null), (error) => {
    assert.ok(containsFailure(error, rejected));
    assert.ok(containsFailure(error, cleanup));
    return true;
  });
  assert.ok(source);
  assert.equal(handled, false);
  assert.equal(runner.isRunning, false);
});
