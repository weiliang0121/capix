import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineObservation, isInvocationCancelled } from '@capix/server-runtime';
import { initializeObserver, ModelInteractions, ModelSource } from '@capix/observer-service';
import { withRuntimeDefinition, reconfigure } from '../fixtures/assembly.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const request = { model: 'fixture', messages: [], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 1, stream: false };
const output = (content) => ({ id: 'fixture', model: 'fixture', content, finishReason: 'stop', usage: null });
const answer = { kind: 'answer', content: '交互结果' };
function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function memoryPersistence() {
  const values = new Map();
  return {
    values,
    create(state) {
      assert.equal(values.has(state.id), false);
      values.set(state.id, structuredClone(state));
    },
    commit({ expectedRevision, state }) {
      assert.equal(values.get(state.id).revision, expectedRevision);
      values.set(state.id, structuredClone(state));
    },
    read(id) {
      return values.get(id);
    },
  };
}
function conversation(provider, configureDefinition) {
  const calls = [];
  const environment = withRuntimeDefinition(configureDefinition, () =>
    initializeObserver({
      invoke: async (input, purpose, signal) => {
        calls.push({ input, purpose, signal });
        if (purpose === 'selection') return output('{"historyIndexes":[]}');
        if (purpose === 'memory') return output('{"memories":[]}');
        return provider(input, signal);
      },
    }),
  );
  return { environment, calls };
}
function watchPending(generation, callback, options) {
  const definition = generation.requestModel;
  reconfigure(definition, {
    observation: [
      ...definition.observation,
      defineObservation(
        {
          requires: {},
          observe(fact) {
            if (fact.kind === 'relation' && fact.change.kind === 'returned' && fact.change.result.status === 'succeeded' && fact.change.result.output.kind === 'pending') callback();
          },
        },
        options,
      ),
    ],
  });
}

test('production request O accepts A1 pending and creates A2 which reads the same exchange without a second send', async () => {
  const response = deferred();
  let pending = 0;
  const { environment, calls } = conversation(
    () => response.promise,
    (_scene, { generation }) =>
      watchPending(generation, () => {
        pending += 1;
        response.resolve(output(JSON.stringify(answer)));
      }),
  );
  let execution;
  assert.deepEqual(
    await environment.runner.run(
      { messages: [{ role: 'user', content: '你好' }] },
      {
        settings,
        executionCallbacks: {
          started: (_context, invocation) => {
            execution = invocation;
          },
        },
      },
    ),
    answer,
  );
  assert.equal(pending, 1);
  assert.equal(calls.filter((call) => call.purpose === 'answer').length, 1);
  const generation = execution.children.values().find((child) => child.key === 'generation').invocation;
  const model = generation.children.values().find((child) => child.key === 'model').invocation;
  const [first, follow] = model.children.values();
  assert.equal(first.key, 'start');
  assert.equal(first.reception.status, 'accepted');
  assert.equal(first.returned.output.kind, 'pending');
  assert.equal(follow.key, 'follow');
  assert.notEqual(first.invocation.context.id, follow.invocation.context.id);
  assert.equal(follow.invocation.context.input.id, first.returned.output.interaction.id);
  assert.equal(follow.reception.status, 'accepted');
  assert.equal(generation.children.values().filter((child) => child.key === 'request').length, 1);
  assert.equal(environment.transcript.length, 2);
  environment.close();
});

test('a fast provider reply completes the initial A without creating a follow call', async () => {
  const { environment, calls } = conversation(async () => output(JSON.stringify(answer)));
  let execution;
  await environment.runner.run(
    { messages: [{ role: 'user', content: '你好' }] },
    {
      settings,
      executionCallbacks: {
        started: (_context, invocation) => {
          execution = invocation;
        },
      },
    },
  );
  const generation = execution.children.values().find((child) => child.key === 'generation').invocation;
  const model = generation.children.values().find((child) => child.key === 'model').invocation;
  assert.equal(model.children.values().length, 1);
  assert.equal(model.children.values()[0].returned.output.kind, 'received');
  environment.close();
});

test('feedback survives A interpretation and can be read by another host without another provider invocation', async () => {
  const persistence = memoryPersistence();
  let sends = 0;
  const host = new ModelInteractions(
    new ModelSource({
      invoke: async () => {
        sends += 1;
        return output('not business JSON');
      },
    }),
    { persistence },
  );
  const signal = new AbortController().signal;
  const ref = host.start(request, 'answer', { timeoutMs: 1000 });
  assert.equal((await host.result(ref, { signal })).content, 'not business JSON');
  assert.equal((await host.result(ref, { signal })).content, 'not business JSON');
  host.close();
  const restored = new ModelInteractions(
    new ModelSource(() => {
      throw new Error('read must not initialize provider');
    }),
    { persistence },
  );
  assert.equal((await restored.result(ref, { signal })).content, 'not business JSON');
  assert.equal(sends, 1);
  assert.equal(restored.source.initialized, false);
  restored.close();
});

test('a restored pending exchange reports unavailable and never sends implicitly', async () => {
  const response = deferred();
  const persistence = memoryPersistence();
  const signal = new AbortController().signal;
  const original = new ModelInteractions(new ModelSource({ invoke: () => response.promise }), { persistence });
  const ref = original.start(request, 'answer', { timeoutMs: 1000 });
  const saved = structuredClone(persistence.read(ref.id));
  const restored = new ModelInteractions(
    new ModelSource(() => {
      throw new Error('must not send');
    }),
    { persistence: { ...memoryPersistence(), read: () => saved } },
  );
  await assert.rejects(restored.result(ref, { signal }), { code: 'INTERACTION_RESTORED_PENDING' });
  assert.equal(restored.source.initialized, false);
  response.resolve(output('{}'));
  await original.settled();
  original.close();
  restored.close();
});

test('local wait expiry leaves the external request alive and supports multiple nondestructive readers', async () => {
  const response = deferred();
  const root = new AbortController();
  let externalSignal;
  const host = new ModelInteractions(
    new ModelSource({
      invoke: async (_request, _purpose, signal) => {
        externalSignal = signal;
        return response.promise;
      },
    }),
  );
  const ref = host.start(request, 'answer', { timeoutMs: 1000 });
  assert.equal((await host.wait(ref, { signal: root.signal, waitMs: 1 })).kind, 'pending');
  assert.equal(externalSignal.aborted, false);
  const first = host.result(ref, { signal: root.signal });
  const second = host.result(ref, { signal: root.signal });
  response.resolve(output('{}'));
  assert.deepEqual(await first, await second);
  host.close();
});

test('cancellation ends the invocation while its independent provider saves a late feedback', async () => {
  const response = deferred();
  const controller = new AbortController();
  const pending = deferred();
  const { environment, calls } = conversation(
    () => response.promise,
    (_scene, { generation }) => watchPending(generation, () => pending.resolve()),
  );
  const running = environment.runner.run({ messages: [{ role: 'user', content: '你好' }] }, { settings, signal: controller.signal });
  const rejected = assert.rejects(running, (error) => isInvocationCancelled(error, controller.signal));
  await pending.promise;
  controller.abort();
  await rejected;
  assert.equal(environment.runner.isRunning, false);
  assert.equal(environment.interactions.active, true);
  assert.equal(calls.find((call) => call.purpose === 'answer').signal.aborted, false);
  assert.throws(() => environment.close(), /active external interactions/);
  response.resolve(output(JSON.stringify(answer)));
  await environment.interactions.settled();
  const saved = environment.interactions.states().find((state) => state.request.purpose === 'answer');
  assert.equal(saved.feedback.payload.content, JSON.stringify(answer));
  assert.equal(calls.filter((call) => call.purpose === 'answer').length, 1);
  assert.equal(environment.runner.isRunning, false);
  assert.equal(environment.interactions.active, false);
  assert.equal(environment.transcript.length, 1);
  environment.close();
});

test('a parent observation fault does not erase or replay an already-started independent exchange', async () => {
  const response = deferred();
  const { environment, calls } = conversation(
    () => response.promise,
    (_scene, { generation }) =>
      watchPending(
        generation,
        () => {
          throw new Error('parent observer fault');
        },
        { failure: 'propagate' },
      ),
  );
  await assert.rejects(environment.runner.run({ messages: [{ role: 'user', content: '你好' }] }, { settings }), (error) => error.code === 'OBSERVATION_FAILED' && error.cause?.message === 'parent observer fault');
  assert.equal(environment.runner.isRunning, false);
  assert.equal(environment.interactions.active, true);
  assert.throws(() => environment.close(), /active external interactions/);
  response.resolve(output(JSON.stringify(answer)));
  await environment.interactions.settled();
  const saved = environment.interactions.states().find((state) => state.request.purpose === 'answer');
  assert.equal(saved.feedback.payload.content, JSON.stringify(answer));
  assert.equal(calls.filter((call) => call.purpose === 'answer').length, 1);
  assert.equal(environment.transcript.length, 1);
  environment.close();
});

test('completed retention is bounded; an evicted in-memory reference cannot cause a new send', async () => {
  let sends = 0;
  const signal = new AbortController().signal;
  const host = new ModelInteractions(
    new ModelSource({
      invoke: async () => {
        sends += 1;
        return output('{}');
      },
    }),
    { retained: 1 },
  );
  const first = host.start(request, 'answer', { timeoutMs: 1000 });
  await host.result(first, { signal });
  const second = host.start(request, 'answer', { timeoutMs: 1000 });
  await host.result(second, { signal });
  assert.equal(host.states().length, 1);
  await assert.rejects(host.result(first, { signal }), { code: 'MODEL_INTERACTION_UNKNOWN' });
  assert.equal(sends, 2);
  host.close();
  assert.throws(() => host.start(request, 'answer', { timeoutMs: 1000 }), { code: 'MODEL_INTERACTIONS_CLOSED' });
});

test('an independent reader may cancel without stopping or waiting for the dispatch owner', async () => {
  for (const method of ['wait', 'result']) {
    const response = deferred();
    const owner = new AbortController();
    const reader = new AbortController();
    let external;
    const host = new ModelInteractions(
      new ModelSource({
        invoke: async (_request, _purpose, signal) => {
          external = signal;
          return response.promise;
        },
      }),
    );
    const ref = host.start(request, 'answer', { timeoutMs: 1000 });
    const reading = method === 'wait' ? host.wait(ref, { signal: reader.signal, waitMs: 1000 }) : host.result(ref, { signal: reader.signal });
    const rejected = assert.rejects(reading, (error) => isInvocationCancelled(error, reader.signal));
    reader.abort();
    await rejected;
    assert.equal(host.active, true);
    assert.equal(external.aborted, false);
    response.resolve(output('{}'));
    assert.equal((await host.result(ref, { signal: owner.signal })).content, '{}');
    host.close();
  }
});

test('host shutdown joins all independent exchanges without tying them to reader cancellation', async () => {
  const first = deferred();
  const second = deferred();
  const reader = new AbortController();
  let calls = 0;
  const host = new ModelInteractions(new ModelSource({ invoke: () => (++calls === 1 ? first.promise : second.promise) }));
  const firstRef = host.start(request, 'answer', { timeoutMs: 1000 });
  const secondRef = host.start(request, 'answer', { timeoutMs: 1000 });
  const reading = host.result(firstRef, { signal: reader.signal });
  const rejected = assert.rejects(reading, (error) => isInvocationCancelled(error, reader.signal));
  reader.abort();
  await rejected;
  assert.throws(() => host.close(), { code: 'MODEL_INTERACTIONS_ACTIVE' });
  let settled = false;
  const draining = host.settled().then(() => {
    settled = true;
  });
  first.resolve(output('{}'));
  await host.result(firstRef, { signal: new AbortController().signal });
  assert.equal(settled, false);
  assert.equal(host.active, true);
  second.resolve(output('{}'));
  await draining;
  assert.equal((await host.result(secondRef, { signal: new AbortController().signal })).content, '{}');
  assert.equal(settled, true);
  host.close();
});

test('cancelled readers leave a durable late reply for a new host without replaying the send', async () => {
  for (const method of ['wait', 'result']) {
    const response = deferred();
    const persistence = memoryPersistence();
    const reader = new AbortController();
    let sends = 0;
    let externalSignal;
    const host = new ModelInteractions(
      new ModelSource({
        invoke: (_request, _purpose, signal) => {
          sends += 1;
          externalSignal = signal;
          return response.promise;
        },
      }),
      { persistence },
    );
    const ref = host.start(request, 'answer', { timeoutMs: 1000 });
    const reading = method === 'wait' ? host.wait(ref, { signal: reader.signal, waitMs: 1000 }) : host.result(ref, { signal: reader.signal });
    const rejected = assert.rejects(reading, (error) => isInvocationCancelled(error, reader.signal));
    reader.abort();
    await rejected;
    assert.equal(externalSignal.aborted, false);
    assert.equal(persistence.read(ref.id).feedback, undefined);
    response.resolve(output('late retained feedback'));
    await host.settled();
    assert.equal(persistence.read(ref.id).feedback.payload.content, 'late retained feedback');
    host.close();
    const restored = new ModelInteractions(new ModelSource(() => assert.fail('reading cannot initialize provider')), { persistence });
    const feedback = await restored.result(ref, { signal: new AbortController().signal, expected: { request, purpose: 'answer' } });
    assert.equal(feedback.content, 'late retained feedback');
    assert.equal(sends, 1);
    restored.close();
  }
});
