import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, InvocationChangeEmitter, ResourceBindings, ResourceOffer, bindResources, bindInvocationObservation, defineObservation, Transcript, createBoundRuntime } from '@capix/server-runtime';

function call({ observe, failure, work, parent, declarations, resources, capture } = {}) {
  const context = new InvocationContext({ mutable: new Map() });
  const identity = { contextId: context.id, level: 'attempt', ...(parent ? { parentContextId: parent.context.id } : {}) };
  return new Invocation({ context, identity, parent: parent ? { invocation: parent } : undefined, signal: new AbortController().signal, work: { maxRounds: 1, execute: () => 'output', ...work }, observation: bindInvocationObservation({ identity, resources: resources ?? new ResourceBindings({}), declarations: declarations ?? [defineObservation({ requires: {}, observe: observe ?? (() => undefined) }, { failure })] }, [], parent?.observation), changes: capture ? new InvocationChangeEmitter(identity, capture) : undefined });
}

function observer(observe, failure) {
  return defineObservation({ requires: {}, observe }, { failure });
}

test('isolated observer stops once while a healthy observer receives all actual call facts', async () => {
  let broken = 0;
  const healthy = [];
  const run = call({
    declarations: [
      observer(() => {
        broken++;
        throw new Error('sink');
      }),
      observer((fact) => {
        healthy.push(fact);
      }),
    ],
  });
  assert.equal(await run.run(), 'output');
  assert.equal(broken, 1);
  assert.deepEqual(
    healthy.map((fact) => fact.eventSequence),
    [1, 2, 3, 4, 5],
  );
  assert.equal(healthy.at(-1).state.status, 'succeeded');
});

test('propagation still dispatches the same fact to healthy peers before stopping work', async () => {
  let effects = 0;
  const healthy = [];
  const run = call({
    declarations: [
      observer(() => {
        throw new Error('sink');
      }, 'propagate'),
      observer((fact) => {
        healthy.push(fact.kind);
      }),
    ],
    work: {
      execute() {
        effects++;
      },
    },
  });
  await assert.rejects(run.run(), { code: 'OBSERVATION_FAILED' });
  assert.equal(effects, 0);
  assert.deepEqual(healthy, ['started', 'finished']);
});

test('required capture and optional observers consume the committed fact independently', async () => {
  const seen = [];
  const run = call({
    capture: {
      capture() {
        throw new Error('buffer');
      },
    },
    observe(fact) {
      seen.push(fact.kind);
    },
  });
  await assert.rejects(run.run());
  assert.deepEqual(seen, ['started', 'finished']);
});

test('parent returned observation failure never becomes a second child return', async () => {
  let child;
  let childValue;
  const facts = [];
  const parent = call({
    declarations: [
      observer((fact) => {
        if (fact.kind === 'relation' && fact.change.kind === 'returned') throw new Error('parent observer');
      }, 'propagate'),
      observer((fact) => {
        facts.push(fact);
      }),
    ],
    work: {
      async execute(_context, owner) {
        child = call({ parent: owner });
        childValue = await child.run();
        return childValue;
      },
    },
  });
  await assert.rejects(parent.run(), { code: 'OBSERVATION_FAILED' });
  assert.equal(childValue, 'output');
  assert.equal(child.context.status, 'succeeded');
  assert.equal(child.failure, undefined);
  assert.equal(parent.children.get(child).returned.status, 'succeeded');
  assert.equal(facts.filter((fact) => fact.kind === 'relation' && fact.change.kind === 'returned').length, 1);
});

for (const phase of ['receiving', 'accepted']) {
  test(`parent ${phase} failure keeps the actual reception state`, async () => {
    let child;
    let effects = 0;
    const parent = call({
      observe(fact) {
        if (fact.kind === 'relation' && fact.change.kind === phase) throw new Error(phase);
      },
      failure: 'propagate',
      work: {
        async execute(_context, owner) {
          child = call({ parent: owner });
          await child.run();
          return owner.children.get(child).accept(() => {
            effects++;
            return 'accepted output';
          });
        },
      },
    });
    await assert.rejects(parent.run(), { code: 'OBSERVATION_FAILED' });
    assert.equal(child.context.status, 'succeeded');
    assert.equal(effects, phase === 'accepted' ? 1 : 0);
    assert.equal(parent.children.get(child).reception.status, phase === 'accepted' ? 'accepted' : 'failed');
  });
}

test('work failure and failing observation preserve both causes without entering business handling', async () => {
  const original = new Error('work');
  const observed = new Error('observer');
  const run = call({
    work: {
      execute() {
        throw original;
      },
    },
    observe(fact) {
      if (fact.kind === 'process' && fact.process.type === 'throw') throw observed;
    },
    failure: 'propagate',
  });
  await assert.rejects(run.run(), (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1].cause === observed);
  assert.equal(run.failure.kind, 'error');
});

test('formal observation ports expire after each synchronous callback; asynchronous declarations are rejected', async () => {
  let retained;
  let writes = 0;
  const offer = new ResourceOffer('test.observation-writer', (_value, activity) => ({
    write() {
      activity.validate();
      writes++;
    },
  }));
  const requirements = { writer: offer.request() };
  const resources = bindResources(requirements, [offer.provide(() => null)])(undefined);
  const run = call({
    resources,
    declarations: [
      defineObservation({
        requires: requirements,
        observe(_fact, ports) {
          retained = ports.writer;
          retained.write();
        },
      }),
    ],
  });
  await run.run();
  assert.equal(writes, 5);
  assert.throws(() => retained.write(), /window has ended/);
  const asyncRun = call({ observe: async () => {}, failure: 'propagate' });
  await assert.rejects(asyncRun.run(), (error) => error.cause?.message === 'Observation must complete synchronously');
});

test('a committed Transcript fact reaches observation even when capture fails; reentrant writes are rejected', () => {
  let transcript;
  const seen = [];
  transcript = new Transcript([], {
    changes: {
      capture() {
        throw new Error('buffer');
      },
    },
    observation: {
      publish(event) {
        seen.push(event);
        assert.throws(() => transcript.append({ role: 'user', content: 'nested' }), /reenter/);
      },
    },
  });
  assert.throws(() => transcript.append({ role: 'user', content: 'committed' }));
  assert.equal(transcript.length, 1);
  assert.equal(transcript.revision, 1);
  assert.equal(seen.length, 1);
});

test('Runtime structure facts have their own order and failed acquisition reporting still releases occupancy', async () => {
  const facts = [];
  const runtime = createBoundRuntime({
    observations: [
      {
        failure: 'propagate',
        bindInvocation() {
          return { observe() {} };
        },
        bindRuntimeStructure(identity) {
          return {
            observe(fact) {
              facts.push(fact);
              assert.equal(fact.runtimeId, identity.runtimeId);
              if (fact.kind === 'acquired') throw new Error('acquire observer');
            },
          };
        },
      },
    ],
  });
  await assert.rejects(
    runtime.reserve(() => assert.fail('must not run')),
    { code: 'OBSERVATION_FAILED' },
  );
  assert.equal(runtime.running, false);
  assert.equal(await runtime.reserve(() => 'next'), 'next');
  assert.deepEqual(
    facts.map((fact) => fact.kind),
    ['established', 'acquired'],
  );
  assert.deepEqual(
    facts.map((fact) => fact.sequence),
    [1, 2],
  );
});

test('an availability check failure follows the observer isolation policy', async () => {
  const seen = [];
  let invalidated = 0;
  const context = new InvocationContext(null);
  const identity = { contextId: context.id, level: 'attempt' };
  const observation = bindInvocationObservation({ identity, resources: new ResourceBindings({}) }, [
    {
      bindInvocation() {
        return {
          available() {
            throw new Error('availability');
          },
          observe() {
            assert.fail('disabled');
          },
        };
      },
      invalidate() {
        invalidated++;
      },
    },
    {
      bindInvocation() {
        return {
          observe(fact) {
            seen.push(fact);
          },
        };
      },
    },
  ]);
  const invocation = new Invocation({ context, identity, observation, signal: new AbortController().signal, work: { maxRounds: 1, execute: () => 'done' } });
  assert.equal(await invocation.run(), 'done');
  assert.equal(invalidated, 1);
  assert.equal(seen.at(-1).kind, 'finished');
});

test('resource construction and its observation failure retain both causes', () => {
  const original = new Error('capture');
  const observed = new Error('unavailable observer');
  const offer = new ResourceOffer('test.capture-fails', () => ({}));
  const resources = bindResources({ value: offer.request() }, [
    offer.provide(() => {
      throw original;
    }),
  ])(undefined);
  resources.attach({
    contextId: 'call',
    validate() {},
    observation: {
      publish(fact) {
        if (fact.phase === 'unavailable') return observed;
      },
    },
  });
  resources.start();
  assert.throws(
    () => resources.values.value,
    (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === observed,
  );
});

test('the invocation error channel preserves a resource fault and its reporting fault together', async () => {
  const original = new Error('resource construction');
  const observed = new Error('resource report');
  const offer = new ResourceOffer('test.resource-double-fault', () => ({}));
  const resources = bindResources({ value: offer.request() }, [
    offer.provide(() => {
      throw original;
    }),
  ])(undefined);
  const context = new InvocationContext(null);
  const invocation = new Invocation({
    context,
    signal: new AbortController().signal,
    work: {
      maxRounds: 1,
      execute() {
        return resources.values.value;
      },
    },
  });
  resources.attach({
    contextId: context.id,
    validate() {},
    error: (error) => invocation.reject(error),
    observation: {
      publish(fact) {
        if (fact.phase === 'unavailable') return observed;
      },
    },
  });
  resources.start();
  await assert.rejects(invocation.run(), (error) => error instanceof AggregateError && error.errors[0] === original && error.errors[1] === observed);
  assert.equal(invocation.failure.kind, 'error');
});
