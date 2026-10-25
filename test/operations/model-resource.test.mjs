import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindResources, InvocationCancelled, isInvocationCancelled, PersistenceError } from '@capix/server-runtime';
import { ModelResource, ModelInteractions, ModelSource } from '@capix/observer-service/conversation';

const request = { model: 'fixture', messages: [], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 1, stream: false };
const output = { id: 'reply', model: 'fixture', content: 'answer', finishReason: 'stop', usage: null };
function endpoint(interactions, controller = new AbortController(), observation) {
  const requests = { creator: ModelResource.create.request(), reader: ModelResource.read.request() };
  const resources = bindResources(requests, [ModelResource.create.provide((value) => value), ModelResource.read.provide((value) => value)])(interactions);
  resources.attach({
    contextId: 'model-resource',
    signal: controller.signal,
    validate() {
      if (controller.signal.aborted) throw new InvocationCancelled(controller.signal);
    },
    observation,
  });
  resources.start();
  return resources.values;
}

test('model start hands off a synchronous identity; wait and result use the common reception contract', async (t) => {
  let sends = 0;
  const interactions = new ModelInteractions(
    new ModelSource({
      invoke: async () => {
        sends++;
        return output;
      },
    }),
  );
  t.after(() => interactions.close());
  const { creator, reader } = endpoint(interactions);
  const ref = creator.start(request, 'answer', { timeoutMs: 1000 });
  assert.equal(typeof ref.id, 'string');
  assert.equal(ref.then, undefined, 'identity delivery remains adjacent to the initial checkpoint');
  await interactions.settled();
  assert.equal(await reader.wait(ref, { waitMs: 1, result: { succeeded: (result) => result.output.content } }), 'answer');
  assert.equal(await reader.result(ref, { expected: { request, purpose: 'answer' }, result: { succeeded: (result) => result.content.length } }), 6);
  assert.equal(sends, 1);
});

test('failed feedback can be received explicitly without resending or changing the retained external result', async (t) => {
  const failure = new Error('external failure');
  let sends = 0;
  const interactions = new ModelInteractions(
    new ModelSource({
      invoke: async () => {
        sends++;
        throw failure;
      },
    }),
  );
  t.after(() => interactions.close());
  const { creator, reader } = endpoint(interactions);
  const ref = creator.start(request, 'answer', { timeoutMs: 1000 });
  await interactions.settled();
  for (const read of [(options) => reader.wait(ref, { waitMs: 1, ...options }), (options) => reader.result(ref, options)]) {
    await assert.rejects(read(), (error) => error === failure);
    assert.equal(
      await read({
        result: {
          failed: (error) => {
            assert.equal(error, failure);
            return 'fallback';
          },
        },
      }),
      'fallback',
    );
  }
  assert.equal(sends, 1);
});

test('a model reader receives the call signal and cannot mask local cancellation as a fallback', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const interactions = new ModelInteractions(new ModelSource({ invoke: () => gate }));
  const controller = new AbortController();
  const { creator, reader } = endpoint(interactions, controller);
  const ref = creator.start(request, 'answer', { timeoutMs: 1000 });
  const pending = reader.result(ref, { result: { failed: () => assert.fail('cancellation is not an ordinary outcome') } });
  controller.abort();
  await assert.rejects(pending, (error) => isInvocationCancelled(error, controller.signal));
  assert.equal(interactions.active, true, 'stopping local consumption does not stop the external exchange');
  release(output);
  await interactions.settled();
  interactions.close();
});

test('a model result callback failure cannot reenter failed reception or initiate another send', async (t) => {
  const interactions = new ModelInteractions(new ModelSource({ invoke: async () => output }));
  t.after(() => interactions.close());
  const { creator, reader } = endpoint(interactions);
  const ref = creator.start(request, 'answer', { timeoutMs: 1000 });
  await interactions.settled();
  const failure = new Error('receiver failure');
  await assert.rejects(
    reader.result(ref, {
      result: {
        succeeded: () => {
          throw failure;
        },
        failed: () => assert.fail('the callback is not the source operation'),
      },
    }),
    (error) => error === failure,
  );
  assert.equal((await reader.result(ref)).content, 'answer');
});

test('a failed feedback commit cannot be consumed as an ordinary model outcome', async (t) => {
  const failure = new Error('feedback store unavailable');
  let sends = 0;
  const interactions = new ModelInteractions(
    new ModelSource({
      invoke: async () => {
        sends++;
        return output;
      },
    }),
    {
      persistence: {
        create() {},
        commit({ state }) {
          if (state.feedback) throw failure;
        },
        read() {},
      },
    },
  );
  t.after(() => interactions.close());
  const { creator, reader } = endpoint(interactions);
  const ref = creator.start(request, 'answer', { timeoutMs: 1000 });
  await interactions.settled();
  for (const read of [(options) => reader.wait(ref, { waitMs: 1, ...options }), (options) => reader.result(ref, options)]) {
    await assert.rejects(read({ result: { failed: () => assert.fail('an uncommitted feedback is not a business fallback') } }), (error) => error instanceof PersistenceError && error.operation === 'interaction.commit' && error.cause === failure);
  }
  assert.equal(interactions.states()[0].feedback, undefined);
  assert.equal(sends, 1, 'reading the failed persistence does not send another model request');
});

test('invalid saved feedback cannot be received as a fallback, while a missing identity can', async (t) => {
  const ref = { id: 'saved-exchange' };
  const saved = { id: ref.id, contract: 'observer.model.v1', revision: 2, delivery: 'started', request: { request, purpose: 'answer', timeoutMs: 1000 }, feedback: { id: 'reply', payload: { malformed: true } } };
  const interactions = new ModelInteractions(new ModelSource({ invoke: () => assert.fail('reading persisted state must not send') }), {
    persistence: {
      create() {},
      commit() {},
      read(id) {
        return id === ref.id ? saved : undefined;
      },
    },
  });
  t.after(() => interactions.close());
  const { reader } = endpoint(interactions);
  await assert.rejects(reader.result(ref, { result: { failed: () => assert.fail('corrupt persisted feedback is not an ordinary outcome') } }), (error) => error instanceof PersistenceError && error.operation === 'model-interaction.restore' && error.cause instanceof Error);
  assert.equal(await reader.result({ id: 'unknown' }, { result: { failed: () => 'missing' } }), 'missing');
});

test('a failed persisted model lookup cannot be consumed as an ordinary outcome', async (t) => {
  const failure = new Error('feedback lookup unavailable');
  const interactions = new ModelInteractions(new ModelSource({ invoke: () => assert.fail('lookup must not send') }), {
    persistence: {
      create() {},
      commit() {},
      read() {
        throw failure;
      },
    },
  });
  t.after(() => interactions.close());
  const { reader } = endpoint(interactions);
  await assert.rejects(reader.result({ id: 'persisted-exchange' }, { result: { failed: () => assert.fail('required lookup failure cannot become a fallback') } }), (error) => error instanceof PersistenceError && error.operation === 'model-interaction.read' && error.cause === failure);
});
