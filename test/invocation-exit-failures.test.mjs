import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { CallableContext, ExceptionContract, Invocation, InvocationContext, InvocationObservation, InvocationResources, ObserverSession, inspectChildCallFailure, invocationResourceFailures } from '@weiliang0121/capix-invocation';
import { Resource, ResourceOffer, ResourceSupply } from '@weiliang0121/capix-resources';
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

function lowLevelChild(pending, store, parent) {
  const deps = { probe: pending.offer.request() };
  const supply = ResourceSupply.capture([pending.offer.provide(() => null)], undefined);
  const resources = new InvocationResources(deps, supply.entries);
  const context = new CallableContext(null, 'node', {}, resources);
  const call = new Invocation({
    context,
    signal: context.signal,
    parent: { invocation: parent, receiveFailure: true },
    checkpoints: { store },
    work: {
      checkpoint: { key: 'test.exit-low-level', version: 1, input: codec, output: codec, points: { ready: { state: codec, execute: () => assert.fail('not a resume test') } } },
      execute(current, invocation) {
        invocation.checkpointWriter.save('ready', null);
        pending.start(current.resources.values.probe);
        return 'body result';
      },
    },
  });
  resources.attach({ contextId: context.id, signal: context.signal, failures: invocationResourceFailures, validate: () => call.requireActive(), error: (error, allow) => call.reject(error, allow) });
  return call;
}

test('low-level cleanup precedes child delivery and CP terminal success and always releases exclusion', async (t) => {
  const cleanup = new Error('cleanup failed');
  const pending = pendingResource(cleanup);
  t.after(() => pending.finish());
  const store = new Journal();
  let child;
  const parent = new Invocation({
    context: new InvocationContext(null),
    signal: new AbortController().signal,
    work: {
      async execute(_context, invocation) {
        child = lowLevelChild(pending, store, invocation);
        await assert.rejects(child.run(), (error) => containsFailure(error, cleanup));
        return 'caught but still failed';
      },
    },
  });
  await assert.rejects(parent.run(), (error) => containsFailure(error, cleanup));
  assert.ok(child.failure);
  assert.equal(child.failure.receptionAllowed, false);
  assert.ok(containsFailure(child.failure.error, cleanup));
  assert.equal(parent.children.get(child).returned.status, 'failed');
  assert.equal(parent.children.get(child).reception.status, 'pending');
  assert.equal(store.read(child.context.id).delivery.status, 'failed');
  assert.equal(store.finishes.includes('succeeded'), false);
  assert.deepEqual(pending.cleanup, ['first', 'second']);
  await assertClaimReleased(store, child.context.id);
});

for (const failing of ['finish', 'observation']) {
  test(`${failing} failure preserves the work fact and releases CP exclusion`, async () => {
    const failure = new Error(`${failing} failed`);
    const store =
      failing === 'finish'
        ? new (class extends Journal {
            finish() {
              throw failure;
            }
          })()
        : new Journal();
    const session = new ObserverSession(
      {
        observe(fact) {
          if (fact.kind === 'finished') throw failure;
        },
      },
      'propagate',
    );
    const context = new InvocationContext(null);
    const call = new Invocation({
      context,
      signal: new AbortController().signal,
      checkpoints: { store },
      ...(failing === 'observation' ? { observation: new InvocationObservation([session], new Map()) } : {}),
      work: {
        checkpoint: { key: 'test.exit-finalization', version: 1, input: codec, output: codec, points: { ready: { state: codec, execute: () => assert.fail('not a resume test') } } },
        execute(_context, invocation) {
          invocation.checkpointWriter.save('ready', null);
          return 'completed work';
        },
      },
    });
    await assert.rejects(call.run(), (error) => containsFailure(error, failure));
    assert.equal(context.status, 'succeeded', 'later finalization failure does not rewrite completed work');
    assert.equal(context.state.output, 'completed work');
    assert.ok(call.failure);
    if (failing === 'observation') assert.equal(store.read(context.id).delivery.status, 'failed');
    else assert.equal(store.read(context.id).delivery, undefined, 'a failing store cannot be reported as saved');
    await assertClaimReleased(store, context.id);
  });
}

for (const invalid of ['throws', 'undefined', 'promise', 'rejected-promise', 'malformed']) {
  test(`low-level Work close ${invalid} is a protected mechanism failure and cannot skip CP release`, async () => {
    const cleanup = new Error('close failed');
    const store = new MemoryCheckpointStore();
    let child;
    let handled = false;
    const parent = new Invocation({
      context: new InvocationContext(null),
      signal: new AbortController().signal,
      work: {
        async execute(_context, invocation) {
          const context = new InvocationContext(null);
          child = new Invocation({
            context,
            signal: new AbortController().signal,
            parent: { invocation, receiveFailure: true },
            checkpoints: { store },
            work: {
              execute: () => 'body',
              close() {
                if (invalid === 'throws') throw cleanup;
                if (invalid === 'undefined') return undefined;
                if (invalid === 'promise') return Promise.resolve({ status: 'succeeded', value: undefined });
                if (invalid === 'rejected-promise') return Promise.reject(cleanup);
                return { status: 'unknown' };
              },
            },
          });
          await assert.rejects(child.run());
          await assert.rejects(
            invocation.children.get(child).handle(() => {
              handled = true;
              return 'fallback';
            }),
          );
          return 'caught';
        },
      },
    });
    await assert.rejects(parent.run());
    assert.equal(handled, false);
    assert.equal(child.failure.receptionAllowed, false);
    assert.equal(parent.children.get(child).returned.status, 'failed');
    if (invalid === 'throws') assert.ok(containsFailure(child.failure.error, cleanup));
    await assertClaimReleased(store, child.context.id);
  });
}

for (const body of ['succeeded', 'error', 'declared']) {
  for (const closing of ['failed-outcome', 'throws']) {
    test(`Work close ${closing} makes a ${body} body non-receivable while retaining each failure`, async () => {
      const bodyFailure = body === 'declared' ? new ExceptionContract('EXIT_BODY_DECLARED').create('body failed', {}) : new Error('body failed');
      const cleanup = new Error('ordinary close failure');
      const store = new Journal();
      let child;
      let delivered;
      let handled = false;
      const parent = new Invocation({
        context: new InvocationContext(null),
        signal: new AbortController().signal,
        work: {
          async execute(_context, invocation) {
            const context = new InvocationContext(null);
            child = new Invocation({
              context,
              signal: new AbortController().signal,
              parent: { invocation, receiveFailure: true },
              checkpoints: { store },
              work: {
                checkpoint: { key: 'test.exit-close-classification', version: 1, input: codec, output: codec, points: { ready: { state: codec, execute: () => assert.fail('not a resume test') } } },
                execute(_context, current) {
                  current.checkpointWriter.save('ready', null);
                  if (body !== 'succeeded') throw bodyFailure;
                  return 'body result';
                },
                close() {
                  if (closing === 'throws') throw cleanup;
                  return { status: 'failed', failure: cleanup };
                },
              },
            });
            try {
              await child.run();
            } catch (error) {
              delivered = error;
            }
            return invocation.children.get(child).handle(() => {
              handled = true;
              return 'invalid fallback';
            });
          },
        },
      });
      await assert.rejects(parent.run());
      assert.equal(handled, false);
      assert.ok(containsFailure(delivered, cleanup));
      if (body !== 'succeeded') assert.ok(containsFailure(delivered, bodyFailure));
      assert.equal(child.failure.receptionAllowed, false);
      assert.equal(parent.children.get(child).returned.failure.receptionAllowed, false);
      assert.equal(parent.children.get(child).reception.status, 'pending');
      assert.equal(store.read(child.context.id).delivery.status, 'failed');
      await assertClaimReleased(store, child.context.id);
    });
  }
}

test('post-commit CP notification failure cannot rewrite the saved successful delivery', async () => {
  const notification = new Error('post-commit notification failed');
  const store = new Journal();
  const context = new InvocationContext(null);
  let notified = false;
  const call = new Invocation({
    context,
    signal: new AbortController().signal,
    checkpoints: {
      store,
      observation: {
        failure: 'propagate',
        observe(fact) {
          if (fact.kind === 'finished') {
            notified = true;
            throw notification;
          }
        },
      },
    },
    work: {
      checkpoint: { key: 'test.exit-post-commit', version: 1, input: codec, output: codec, points: { ready: { state: codec, execute: () => assert.fail('not a resume test') } } },
      execute(_context, invocation) {
        invocation.checkpointWriter.save('ready', null);
        return 'committed';
      },
    },
  });
  assert.equal(await call.run(), 'committed');
  assert.equal(notified, true);
  assert.deepEqual(store.finishes, ['succeeded']);
  assert.equal(store.read(context.id).delivery.status, 'succeeded');
  await assertClaimReleased(store, context.id);
});

test('failure classification cannot skip Work close when a thrown proxy changes prototype inspection behavior', async () => {
  const inspectionFailure = new Error('prototype inspection failed');
  let inspections = 0;
  const original = new Proxy(
    {},
    {
      getPrototypeOf() {
        if (++inspections === 1) return Object.prototype;
        throw inspectionFailure;
      },
    },
  );
  const store = new Journal();
  let child;
  let delivered;
  let closed = 0;
  let handled = false;
  const parent = new Invocation({
    context: new InvocationContext(null),
    signal: new AbortController().signal,
    work: {
      async execute(_context, invocation) {
        const context = new InvocationContext(null);
        child = new Invocation({
          context,
          signal: new AbortController().signal,
          parent: { invocation, receiveFailure: true },
          checkpoints: { store },
          work: {
            checkpoint: { key: 'test.exit-classification-failure', version: 1, input: codec, output: codec, points: { ready: { state: codec, execute: () => assert.fail('not a resume test') } } },
            execute(_context, current) {
              current.checkpointWriter.save('ready', null);
              throw original;
            },
            close() {
              closed++;
              return { status: 'succeeded', value: undefined };
            },
          },
        });
        try {
          await child.run();
        } catch (error) {
          delivered = error;
        }
        return invocation.children.get(child).handle(() => {
          handled = true;
          return 'invalid fallback';
        });
      },
    },
  });
  await assert.rejects(parent.run());
  assert.equal(closed, 1);
  assert.equal(handled, false);
  assert.ok(inspections >= 2);
  assert.equal(child.failure.receptionAllowed, false);
  assert.equal(parent.children.get(child).returned.status, 'failed');
  assert.equal(store.read(child.context.id).delivery.status, 'failed');

  // Inspect data descriptors only: the assertion itself must not repeat instanceof on
  // the hostile thrown value or mistake an accessor's result for retained evidence.
  const retained = (value, target, seen = new Set()) => {
    if (value === target) return true;
    if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return false;
    seen.add(value);
    const cause = Object.getOwnPropertyDescriptor(value, 'cause');
    if (cause && 'value' in cause && retained(cause.value, target, seen)) return true;
    const errors = Object.getOwnPropertyDescriptor(value, 'errors');
    return !!errors && 'value' in errors && Array.isArray(errors.value) && errors.value.some((item) => retained(item, target, seen));
  };
  assert.ok(retained(delivered, original));
  assert.ok(retained(delivered, inspectionFailure));
  await assertClaimReleased(store, child.context.id);
});
