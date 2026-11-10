import assert from 'node:assert/strict';

import { test } from 'node:test';

import { CallableContext, Invocation, InvocationResources, ObservationError, attachInvocationResources, prepareCheckpointRestoration } from '@weiliang0121/capix-invocation';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

import { ResourceOffer, ResourceSupply } from '@weiliang0121/capix-resources';

const codec = { encode: (value) => value, decode: (value) => value };

function work(execute, resume = execute) {
  return {
    execute,
    checkpoint: { key: 'feedback-test', version: 1, input: codec, output: codec, points: { saved: { state: codec, references: {}, execute: resume } } },
  };
}

function create(work, checkpoints, { restore, resources = new InvocationResources({}) } = {}) {
  const context = new CallableContext('input', 'scene', {}, resources);
  if (restore) context.installCheckpoint({ id: restore.head.image.frame.owner.contextId, round: 1, currentInput: 'input' });
  const invocation = new Invocation({ context, signal: context.signal, work, checkpoints, restore });
  attachInvocationResources(invocation, resources);
  return invocation;
}

function saved(store) {
  store.save({ id: 'saved-image', formatVersion: 6, contract: { key: 'feedback-test', version: 1 }, point: 'saved', frame: { owner: { contextId: 'saved-context', kind: 'scene' }, phase: 'execute', round: 1, input: 'input', currentInput: 'input', nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
  return store.read('saved-context');
}

function normalWork() {
  return work((_context, invocation) => {
    invocation.checkpointWriter.save('saved', null);
    return 'answer';
  });
}

function assertOneActivity(facts) {
  assert.equal(new Set(facts.map((fact) => fact.activityId)).size, 1);
  assert.deepEqual(
    facts.map((fact) => fact.sequence),
    facts.map((_fact, index) => index + 1),
  );
  assert.equal(new Set(facts).size, facts.length);
}

test('checkpoint observation and passive feedback receive one shared fact without duplicate identity or sequence', async () => {
  const feedback = [];
  const observed = [];
  const store = new MemoryCheckpointStore();
  const invocation = create(normalWork(), { store, feedback: { receive: (fact) => void feedback.push(fact) }, observation: { observe: (fact) => void observed.push(fact) } });
  assert.equal(await invocation.run(), 'answer');
  assert.deepEqual(
    feedback.map((fact) => fact.kind),
    ['captured', 'saved', 'finishing', 'finished'],
  );
  assertOneActivity(feedback);
  observed.forEach((fact, index) => assert.equal(fact, feedback[index]));
  assert.equal(store.read(invocation.context.id).delivery.status, 'succeeded');
});

for (const async of [false, true]) {
  test(`checkpoint ${async ? 'async' : 'throwing'} feedback is disabled without changing observation or committed delivery`, async () => {
    const failure = new Error('passive receiver failed');
    let received = 0;
    let reported = 0;
    const observed = [];
    const store = new MemoryCheckpointStore();
    const invocation = create(normalWork(), {
      store,
      feedback: {
        receive() {
          received++;
          if (async) return Promise.reject(failure);
          throw failure;
        },
        failed(error) {
          reported++;
          assert.ok(async ? error instanceof TypeError : error === failure);
        },
      },
      observation: { failure: 'propagate', observe: (fact) => void observed.push(fact) },
    });
    assert.equal(await invocation.run(), 'answer');
    assert.equal(received, 1);
    assert.equal(reported, 1);
    assert.equal(observed.length, 4);
    assert.equal(store.read(invocation.context.id).delivery.status, 'succeeded');
  });
}

for (const kind of ['captured', 'saved', 'finishing', 'finished']) {
  test(`passive CP feedback preserves strict ${kind} failure and the existing commit boundary`, async () => {
    const failure = new Error(`strict ${kind} failure`);
    const feedback = [];
    const observed = [];
    const store = new MemoryCheckpointStore();
    const invocation = create(normalWork(), {
      store,
      feedback: { receive: (fact) => void feedback.push(fact) },
      observation: {
        failure: 'propagate',
        observe(fact) {
          observed.push(fact);
          if (fact.kind === kind) throw failure;
        },
      },
    });
    if (kind === 'finished') assert.equal(await invocation.run(), 'answer');
    else await assert.rejects(invocation.run(), (error) => error instanceof ObservationError && error.cause === failure);
    assertOneActivity(feedback);
    observed.forEach((fact, index) => assert.equal(fact, feedback[index]));
    const head = store.read(invocation.context.id);
    if (kind === 'captured') assert.equal(head, undefined);
    else {
      assert.equal(head.image.point, 'saved');
      assert.equal(head.delivery.status, kind === 'finished' ? 'succeeded' : 'failed');
    }
    if (kind === 'saved' || kind === 'finishing') assert.ok(feedback.length > observed.length, 'strict observer stops without cutting off passive feedback');
  });
}

for (const boundary of ['activity', 'resource']) {
  test(`recovery ${boundary} observation failure does not disable subsequent passive activity and terminal facts`, async () => {
    const store = new MemoryCheckpointStore();
    const head = saved(store);
    const feedback = [];
    const observed = [];
    const failure = new Error(`strict recovered ${boundary}`);
    let reads = 0;
    const offer = new ResourceOffer({ methods: { read: () => ++reads } });
    const deps = { value: offer.request() };
    const resources = new InvocationResources(deps, ResourceSupply.capture([offer.provide(() => null)], undefined).entries);
    const body = work(
      () => assert.fail('recovery must not execute the original body'),
      (context) => context.resources.view(deps, 'checkpoint:saved').value.read(),
    );
    const invocation = create(
      body,
      {
        store,
        feedback: { receive: (fact) => void feedback.push(fact) },
        observation: {
          failure: 'propagate',
          observe(fact) {
            observed.push(fact);
            if (boundary === 'activity' ? fact.kind === 'activity' && fact.fact.kind === 'process' && fact.fact.process.type === 'start' : fact.kind === 'resource' && fact.fact.phase === 'returned') throw failure;
          },
        },
      },
      { restore: { head }, resources },
    );
    await assert.rejects(invocation.run(), (error) => error instanceof ObservationError && error.cause instanceof ObservationError && error.cause.cause === failure);
    assertOneActivity(feedback);
    observed.forEach((fact, index) => assert.equal(fact, feedback[index]));
    assert.ok(feedback.every((fact) => fact.recovering && fact.contextId === 'saved-context'));
    assert.ok(
      feedback.some((fact) => fact.kind === 'activity' && fact.fact.kind === 'finished' && fact.fact.state.status === 'failed'),
      'the recovery bridge must continue forwarding actual failure completion',
    );
    assert.equal(feedback.at(-1).kind, 'finished');
    assert.equal(feedback.at(-1).status, 'failed');
    assert.equal(store.read('saved-context').delivery.status, 'failed');
    assert.equal(reads, boundary === 'resource' ? 1 : 0);
  });
}

test('restoration preparation shares one failure fact across passive feedback and strict observation', () => {
  const feedback = [];
  const observed = [];
  const failure = new Error('strict preparation observer');
  assert.throws(
    () =>
      prepareCheckpointRestoration(
        {
          store: new MemoryCheckpointStore(),
          feedback: { receive: (fact) => void feedback.push(fact) },
          observation: {
            failure: 'propagate',
            observe(fact) {
              observed.push(fact);
              throw failure;
            },
          },
        },
        normalWork().checkpoint,
        'missing',
        { kind: 'scene' },
      ),
    (error) => error instanceof AggregateError && error.errors[0] === feedback[0].error && error.errors[1] instanceof ObservationError && error.errors[1].cause === failure,
  );
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0], observed[0]);
  assert.equal(feedback[0].kind, 'failed');
  assert.equal(feedback[0].stage, 'restore');
  assert.equal(feedback[0].contextId, 'missing');
  assert.equal(feedback[0].sequence, 1);
});

test('passive preparation feedback cannot replace the missing-checkpoint failure', () => {
  let notified = 0;
  let observed;
  assert.throws(
    () =>
      prepareCheckpointRestoration(
        {
          store: new MemoryCheckpointStore(),
          feedback: {
            receive() {
              notified++;
              throw new Error('passive failure');
            },
          },
          observation: {
            observe(fact) {
              observed = fact;
            },
          },
        },
        normalWork().checkpoint,
        'missing',
        { kind: 'scene' },
      ),
    (error) => error === observed.error && /unavailable/.test(error.message),
  );
  assert.equal(notified, 1);
});

test('preparation feedback is available without installing a mechanism observer', () => {
  const feedback = [];
  assert.throws(
    () => prepareCheckpointRestoration({ store: new MemoryCheckpointStore(), feedback: { receive: (fact) => void feedback.push(fact) } }, normalWork().checkpoint, 'missing', { kind: 'scene' }),
    (error) => error === feedback[0].error && /unavailable/.test(error.message),
  );
  assert.equal(feedback.length, 1);
  assert.equal(feedback[0].recovering, true);
});
