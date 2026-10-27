import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { Resource, ResourceOffer } from '@capix/resources';
import { callableHooks, Node, Resources, Runner, Scene } from '@capix/server-runtime';

const output = { result: (value) => value, delta: (value) => value };
const codec = { encode: structuredClone, decode: structuredClone };
const collect = (events) => ({ receive: (event) => void events.push(event) });
const entryEvents = (events, kind) => events.filter((event) => event.source === 'entry' && event.fact.kind === kind);

test('Runner observation connects root, child and resource metadata without evaluating descriptions or exposing bodies', async () => {
  const events = [];
  const outputs = [];
  let descriptions = 0;
  const describe = () => {
    descriptions++;
    throw new Error('metadata subscriptions must not evaluate resource descriptions');
  };
  const value = new ResourceOffer({
    name: 'value',
    expose: (origin, activity) => ({ read: () => activity.runSync('read', { input: describe, output: describe }, () => origin) }),
    describe,
  });
  const child = new Node({ name: 'read', deps: { value: value.request() }, run: (work) => work.resources.value.read() });
  const scene = new Scene({ name: 'root', output }).add({ child });
  scene.run = (work) => work.children.child.invoke(work.input);
  const runner = new Runner(scene, new Resources().register(new Resource('PRIVATE_RESOURCE_BODY'), value)).build();
  runner.observation.subscribe(collect(events));
  runner.output.subscribe(collect(outputs));

  assert.equal(await runner.run('PRIVATE_INPUT_BODY'), 'PRIVATE_RESOURCE_BODY');
  assert.equal(descriptions, 0);
  const requested = entryEvents(events, 'requested');
  assert.equal(requested.length, 1);
  const entryId = requested[0].entryId;
  assert.ok(events.every((event) => event.runnerId === runner.id && event.entryId === entryId));
  assert.ok(outputs.every((event) => event.entryId === entryId));
  assert.equal(entryEvents(events, 'settled').at(-1).fact.status, 'succeeded');
  assert.equal(events.at(-1).fact.kind, 'settled');
  const starts = events.filter((event) => event.source === 'invocation' && event.fact.kind === 'started');
  assert.equal(starts.length, 2);
  const root = starts.find((event) => event.fact.identity.kind === 'scene').fact.identity;
  const leaf = starts.find((event) => event.fact.identity.kind === 'node').fact.identity;
  assert.equal(leaf.parentContextId, root.contextId);
  const resourceFacts = events.filter((event) => event.source === 'resource');
  assert.ok(resourceFacts.some((event) => event.fact.contextId === leaf.contextId && event.fact.phase === 'returned'));
  assert.ok(resourceFacts.every((event) => !('describe' in event.fact)));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_INPUT_BODY|PRIVATE_RESOURCE_BODY/);
});

test('an unbuilt Runner still reports a failed entry matching its rejected run Promise', async () => {
  const runner = new Runner(new Scene({ run: (work) => work.input }), new Resources());
  const events = [];
  const outputs = [];
  runner.observation.subscribe(collect(events));
  runner.output.subscribe(collect(outputs));

  await assert.rejects(runner.run('before build'));
  assert.equal(entryEvents(events, 'requested').length, 1);
  assert.equal(entryEvents(events, 'settled').length, 1);
  assert.equal(entryEvents(events, 'settled')[0].fact.status, 'failed');
  assert.equal(new Set(events.map((event) => event.entryId)).size, 1);
  assert.deepEqual(outputs, []);
  assert.equal(
    events.some((event) => event.source === 'invocation'),
    false,
  );

  runner.build();
  assert.equal(await runner.run('after build'), 'after build');
  assert.equal(entryEvents(events, 'requested').length, 2);
  assert.equal(entryEvents(events, 'settled').at(-1).fact.status, 'succeeded');
  assert.notEqual(entryEvents(events, 'requested')[0].entryId, entryEvents(events, 'requested')[1].entryId);
});

for (const stage of ['validate', 'capture']) {
  test(`failure during ${stage} produces entry failure and settled without pretending output started`, async () => {
    const fault = new Error(`${stage} failed`);
    const value = new ResourceOffer({ methods: { read: (origin) => origin } });
    const scene = new Scene({ deps: { value: value.request() }, run: () => assert.fail('business must not execute') });
    const resources = new Resources();
    resources
      .capture(scene, () => {
        if (stage === 'capture') throw fault;
        return 'value';
      })
      .register(value, (origin) => origin);
    const runner = new Runner(scene, resources, undefined, {
      validate() {
        if (stage === 'validate') throw fault;
      },
    }).build();
    const events = [];
    const outputs = [];
    runner.observation.subscribe(collect(events));
    runner.output.subscribe(collect(outputs));

    await assert.rejects(runner.run(null));
    assert.equal(entryEvents(events, 'entry-failed').length, 1);
    assert.equal(entryEvents(events, 'settled').length, 1);
    assert.equal(entryEvents(events, 'settled')[0].fact.status, 'failed');
    assert.equal(new Set(events.map((event) => event.entryId)).size, 1);
    assert.deepEqual(outputs, []);
    assert.equal(runner.isRunning, false);
  });
}

test('busy, cancelled and released-reentrant runs retain their own entry identities and final outcomes', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const events = [];
  const outputs = [];
  let firstEntryId;
  let follow;
  const runner = new Runner(
    new Scene({
      output,
      async run(work) {
        if (work.input === 'first') {
          entered.resolve();
          await release.promise;
        }
        return work.input;
      },
    }),
    new Resources(),
  ).build();
  runner.observation.subscribe({
    receive(event) {
      events.push(event);
      if (event.source !== 'entry') return;
      if (event.fact.kind === 'requested' && firstEntryId === undefined) firstEntryId = event.entryId;
      if (event.fact.kind === 'released' && event.entryId === firstEntryId) follow = runner.run('follow');
    },
  });
  runner.output.subscribe(collect(outputs));
  const active = runner.run('first');
  const cancelled = assert.rejects(active);
  await entered.promise;
  await assert.rejects(runner.run('busy'), { code: 'RUNTIME_BUSY' });
  const busyEntryId = entryEvents(events, 'requested')[1].entryId;
  assert.equal(runner.cancel(), true);
  assert.equal(
    entryEvents(events, 'settled').some((event) => event.entryId === firstEntryId),
    false,
  );
  release.resolve();
  await cancelled;
  assert.equal(await follow, 'follow');

  const requested = entryEvents(events, 'requested');
  assert.equal(requested.length, 3);
  assert.equal(new Set(requested.map((event) => event.entryId)).size, 3);
  const statuses = new Map(entryEvents(events, 'settled').map((event) => [event.entryId, event.fact.status]));
  assert.equal(statuses.size, 3);
  assert.equal(statuses.get(firstEntryId), 'cancelled');
  assert.equal(statuses.get(busyEntryId), 'failed');
  assert.equal(statuses.get(requested[2].entryId), 'succeeded');
  assert.equal(entryEvents(events, 'rejected')[0].entryId, busyEntryId);
  assert.equal(
    outputs.some((event) => event.entryId === busyEntryId),
    false,
  );
  assert.equal(outputs.find((event) => event.kind === 'completed').entryId, requested[2].entryId);
});

test('cancellation from attached feedback prevents formal started hooks and business work while preserving the established identity', async () => {
  const events = [];
  const outputs = [];
  let started = 0;
  let runs = 0;
  let cancelOnce = true;
  const scene = new Scene({ output, run: () => ++runs });
  const runner = new Runner(scene, new Resources(), undefined, {
    hooks: [callableHooks(scene, { started: () => () => void started++ })],
  }).build();
  runner.observation.subscribe({
    receive(event) {
      events.push(event);
      if (cancelOnce && event.source === 'entry' && event.fact.kind === 'attached') {
        cancelOnce = false;
        assert.equal(runner.cancel(), true);
      }
    },
  });
  runner.output.subscribe(collect(outputs));

  await assert.rejects(runner.run(null), { code: 'INVOCATION_CANCELLED' });
  const attached = entryEvents(events, 'attached');
  assert.equal(attached.length, 1);
  assert.equal(typeof attached[0].fact.identity.contextId, 'string');
  assert.equal(attached[0].fact.identity.kind, 'scene');
  assert.equal(started, 0);
  assert.equal(runs, 0);
  assert.deepEqual(outputs, []);
  assert.equal(entryEvents(events, 'released').length, 1);
  assert.equal(entryEvents(events, 'settled')[0].entryId, attached[0].entryId);
  assert.equal(entryEvents(events, 'settled')[0].fact.status, 'cancelled');
  assert.equal(runner.isRunning, false);

  assert.equal(await runner.run(null), 1);
  assert.equal(started, 1);
  assert.equal(entryEvents(events, 'settled').at(-1).fact.status, 'succeeded');
  assert.notEqual(entryEvents(events, 'attached').at(-1).fact.identity.contextId, attached[0].fact.identity.contextId);
});

test('options snapshot failure remains observable without acquiring the Runner or opening output', async () => {
  const events = [];
  const outputs = [];
  let runs = 0;
  const fault = new Error('options could not be read');
  const runner = new Runner(new Scene({ output, run: () => ++runs }), new Resources()).build();
  runner.observation.subscribe(collect(events));
  runner.output.subscribe(collect(outputs));
  await assert.rejects(
    runner.run(null, {
      get signal() {
        throw fault;
      },
    }),
    (error) => error === fault,
  );

  assert.deepEqual(
    entryEvents(events, 'requested').map((event) => event.fact.mode),
    ['run'],
  );
  assert.equal(entryEvents(events, 'acquired').length, 0);
  assert.equal(entryEvents(events, 'settled')[0].fact.status, 'failed');
  assert.deepEqual(outputs, []);
  assert.equal(runner.isRunning, false);
  assert.equal(runs, 0);
  assert.equal(await runner.run(null), 1);
});

test('requested subscribers cannot replace already fixed top-level invocation options', async () => {
  const original = new AbortController();
  const replacement = AbortSignal.abort('replacement is already cancelled');
  const options = { signal: original.signal, label: 'original' };
  const value = new ResourceOffer({ methods: { read: (origin) => origin } });
  const scene = new Scene({ deps: { value: value.request() }, run: (work) => work.resources.value.read() });
  const resources = new Resources();
  resources.capture(scene, (_input, fixed) => fixed.label).register(value, (label) => label);
  const runner = new Runner(scene, resources, undefined, {
    validate(fixed) {
      assert.equal(fixed.signal, original.signal);
      assert.equal(fixed.label, 'original');
    },
  }).build();
  runner.observation.subscribe({
    receive(event) {
      if (event.source === 'entry' && event.fact.kind === 'requested') {
        options.signal = replacement;
        options.label = 'changed';
      }
    },
  });

  assert.equal(await runner.run(null, options), 'original');
  assert.equal(options.signal, replacement);
  assert.equal(options.label, 'changed');
});

test('running without subscribers does not disable later or mid-run observation subscriptions', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const events = [];
  const runner = new Runner(
    new Scene({
      async run(work) {
        if (work.input === 'middle') {
          entered.resolve();
          await release.promise;
        }
        return work.input;
      },
    }),
    new Resources(),
  ).build();
  assert.equal(await runner.run('unobserved'), 'unobserved');
  const active = runner.run('middle');
  await entered.promise;
  const unsubscribe = runner.observation.subscribe(collect(events));
  assert.deepEqual(events, [], 'new subscriptions do not replay past events');
  release.resolve();
  assert.equal(await active, 'middle');
  assert.equal(entryEvents(events, 'requested').length, 0);
  assert.equal(entryEvents(events, 'settled').length, 1);
  assert.equal(entryEvents(events, 'settled')[0].fact.status, 'succeeded');
  assert.equal(await runner.run('observed'), 'observed');
  assert.equal(entryEvents(events, 'requested').length, 1);
  assert.equal(entryEvents(events, 'settled').length, 2);
  unsubscribe();
  unsubscribe();
  const count = events.length;
  assert.equal(await runner.run('unsubscribed'), 'unsubscribed');
  assert.equal(events.length, count);
});

test('one faulty observation subscriber cannot disable another subscriber or future entries', async () => {
  const events = [];
  let received = 0;
  let reported = 0;
  let asynchronous = 0;
  const runner = new Runner(new Scene({ run: (work) => work.input }), new Resources()).build();
  runner.observation.subscribe({
    receive() {
      received++;
      throw new Error('consumer failed');
    },
    failed() {
      reported++;
      throw new Error('report failed');
    },
  });
  runner.observation.subscribe({
    receive() {
      asynchronous++;
      return Promise.reject(new Error('async receiver failed'));
    },
  });
  runner.observation.subscribe(collect(events));
  assert.equal(await runner.run('first'), 'first');
  assert.equal(await runner.run('second'), 'second');
  assert.equal(received, 1);
  assert.equal(reported, 1);
  assert.equal(asynchronous, 1);
  assert.deepEqual(
    entryEvents(events, 'settled').map((event) => event.fact.status),
    ['succeeded', 'succeeded'],
  );
});

test('completed root output does not turn strict release failure into a successful entry', async () => {
  const events = [];
  const outputs = [];
  const runner = new Runner(new Scene({ output, run: () => 'answer' }), new Resources(), undefined, {
    observations: [
      {
        failure: 'propagate',
        bindInvocation: () => ({ observe() {} }),
        bindDriver: () => ({
          observe(fact) {
            if (fact.kind === 'released') throw new Error('strict release failed');
          },
        }),
      },
    ],
  }).build();
  runner.observation.subscribe(collect(events));
  runner.output.subscribe(collect(outputs));

  await assert.rejects(runner.run(null));
  assert.equal(outputs.at(-1).kind, 'completed');
  assert.equal(outputs.at(-1).result, 'answer');
  assert.equal(entryEvents(events, 'settled').at(-1).fact.status, 'failed');
  assert.equal(entryEvents(events, 'settled').at(-1).entryId, outputs.at(-1).entryId);
});

for (const stage of ['saved', 'finishing', 'finished']) {
  test(`strict checkpoint ${stage} feedback failure does not suppress later passive entry and checkpoint facts`, async () => {
    const store = new MemoryCheckpointStore();
    const point = { name: 'saved', state: codec, references: {}, resume: { deps: {}, run: () => 'restored' } };
    const scene = new Scene({
      output,
      checkpoint: { key: 'runner-observation', version: 1, input: codec, output: codec, points: [point] },
      run(work) {
        work.checkpoint({ point, state: { private: 'PRIVATE_CP_STATE' }, refs: {} });
        return 'answer';
      },
    });
    const runner = new Runner(scene, new Resources(), undefined, {
      checkpoints: {
        store,
        observation: {
          failure: 'propagate',
          observe(fact) {
            if (fact.kind === stage) throw new Error(`strict ${stage} failed`);
          },
        },
      },
    }).build();
    const events = [];
    const outputs = [];
    runner.observation.subscribe(collect(events));
    runner.output.subscribe(collect(outputs));
    if (stage === 'finished') assert.equal(await runner.run('PRIVATE_CP_INPUT'), 'answer');
    else await assert.rejects(runner.run('PRIVATE_CP_INPUT'));
    const checkpoints = events.filter((event) => event.source === 'checkpoint');
    assert.ok(checkpoints.some((event) => event.fact.kind === stage));
    assert.ok(checkpoints.some((event) => event.fact.kind === 'finished'));
    assert.equal(entryEvents(events, 'settled').at(-1).fact.status, stage === 'finished' ? 'succeeded' : 'failed');
    if (stage === 'finishing') assert.equal(outputs.at(-1).kind, 'completed');
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_CP_INPUT|PRIVATE_CP_STATE/);
  });
}

test('separate recovery activities keep one context identity but distinct entry identities on both ports', async () => {
  class Store extends MemoryCheckpointStore {
    unavailable = true;
    finish(...args) {
      if (this.unavailable) throw new Error('final persistence unavailable before commit');
      return super.finish(...args);
    }
  }
  const store = new Store();
  const contextId = 'runner-observation-restored';
  const point = {
    name: 'saved',
    state: codec,
    references: {},
    resume: {
      deps: {},
      run(work) {
        work.output.emit('preview');
        return 'answer';
      },
    },
  };
  const scene = new Scene({
    output,
    run: () => assert.fail('normal entry must not replay'),
    checkpoint: { key: 'restored-observation', version: 1, input: codec, output: codec, points: [point] },
  });
  store.save(
    {
      id: 'saved-image',
      formatVersion: 5,
      contract: { key: 'restored-observation', version: 1 },
      point: 'saved',
      frame: { owner: { contextId, kind: 'scene' }, round: 1, phase: 'execute', input: 'PRIVATE_RESTORED_INPUT', currentInput: 'PRIVATE_RESTORED_INPUT', nextChildOrder: 0, children: [] },
      state: { private: 'PRIVATE_RESTORED_STATE' },
      references: {},
    },
    0,
  );
  const runner = new Runner(scene, new Resources(), undefined, { checkpoints: { store } }).build();
  const events = [];
  const outputs = [];
  runner.observation.subscribe(collect(events));
  runner.output.subscribe(collect(outputs));
  await assert.rejects(runner.resume(contextId));
  assert.equal(store.read(contextId).delivery, undefined);
  store.unavailable = false;
  assert.equal(await runner.resume(contextId), 'answer');

  const requests = entryEvents(events, 'requested');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].entryId, requests[1].entryId);
  const starts = outputs.filter((event) => event.kind === 'started');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].contextId, contextId);
  assert.equal(starts[1].contextId, contextId);
  assert.equal(starts[0].sequence, 1);
  assert.equal(starts[1].sequence, 1);
  assert.equal(starts[0].entryId, requests[0].entryId);
  assert.equal(starts[1].entryId, requests[1].entryId);
  assert.deepEqual(
    entryEvents(events, 'settled').map((event) => event.fact.status),
    ['failed', 'succeeded'],
  );
  const installed = events.filter((event) => event.source === 'checkpoint' && event.fact.kind === 'installed');
  assert.equal(installed.length, 2);
  assert.notEqual(installed[0].fact.activityId, installed[1].fact.activityId);
  assert.ok(installed.every((event) => !('frame' in event.fact)));
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_RESTORED_INPUT|PRIVATE_RESTORED_STATE/);
});
