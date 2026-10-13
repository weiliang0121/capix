import test from 'node:test';
import assert from 'node:assert/strict';
import { bindResources, InvocationCancelled, isInvocationCancelled } from '@capix/server-runtime';
import { DeepSeekProvider, ModelResource, ModelSource, ModelInteractions } from '@capix/observer-service';

const request = { model: 'fixture', messages: [], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 1, stream: false };
const output = { id: 'fixture', model: 'fixture', content: '{}', finishReason: 'stop', usage: null };
function model(provider) {
  const interactions = new ModelInteractions(new ModelSource(provider));
  const resources = bindResources({ creator: ModelResource.create.request(), reader: ModelResource.read.request() }, [ModelResource.create.provide(() => interactions), ModelResource.read.provide(() => interactions)])(null).values;
  return { invoke: (request, purpose, controls) => resources.reader.result(resources.creator.start(request, purpose, controls), controls) };
}

test('provider fetch and body abort preserve the native cause and exact control identity', async () => {
  for (const stage of ['fetch', 'body']) {
    const controller = new AbortController();
    const reason = new Error('cancel requested');
    const cause = stage === 'fetch' ? reason : new DOMException('body reader aborted', 'AbortError');
    const provider = new DeepSeekProvider('fixture-key', async () => {
      if (stage === 'fetch') {
        controller.abort(reason);
        throw cause;
      }
      return {
        ok: true,
        json: async () => {
          controller.abort(reason);
          throw cause;
        },
      };
    });
    await assert.rejects(provider.invoke(request, 'answer', controller.signal), (error) => isInvocationCancelled(error, controller.signal) && error.cause === cause);
  }
});

test('concurrent abort does not relabel an independent fetch or decoding failure', async () => {
  for (const stage of ['fetch', 'body']) {
    const controller = new AbortController();
    const cause = stage === 'fetch' ? new TypeError('network failed') : new SyntaxError('bad JSON');
    const provider = new DeepSeekProvider('fixture-key', async () => {
      if (stage === 'fetch') {
        controller.abort();
        throw cause;
      }
      return {
        ok: true,
        json: async () => {
          controller.abort();
          throw cause;
        },
      };
    });
    await assert.rejects(provider.invoke(request, 'answer', controller.signal), (error) => error.code === (stage === 'fetch' ? 'NETWORK_ERROR' : 'PROVIDER_ENVELOPE') && error.cause === cause && !isInvocationCancelled(error, controller.signal));
  }
});

test('model resource normalizes merged cancellation to the caller signal before resource capture', async () => {
  for (const normalized of [false, true]) {
    const controller = new AbortController();
    const endpoint = model({
      invoke: async (_request, _purpose, signal) => {
        controller.abort();
        throw normalized ? new InvocationCancelled(signal) : signal.reason;
      },
    });
    await assert.rejects(endpoint.invoke(request, 'answer', { signal: controller.signal, timeoutMs: 1000 }), (error) => isInvocationCancelled(error, controller.signal));
  }
});

test('provider return after cancellation is stopped at the model acceptance boundary', async () => {
  const controller = new AbortController();
  const endpoint = model({
    invoke: async () => {
      controller.abort();
      return output;
    },
  });
  await assert.rejects(endpoint.invoke(request, 'answer', { signal: controller.signal, timeoutMs: 1000 }), (error) => isInvocationCancelled(error, controller.signal));
});

test('model timeout is a failure distinct from parent cancellation and retains its cause', async () => {
  const controller = new AbortController();
  const endpoint = model({ invoke: (_request, _purpose, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(endpoint.invoke(request, 'answer', { signal: controller.signal, timeoutMs: 1 }), (error) => error.code === 'MODEL_TIMEOUT' && error.cause?.name === 'TimeoutError' && !isInvocationCancelled(error, controller.signal));
    assert.equal(controller.signal.aborted, false);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('resource adaptation does not hide a fault or a composite error just because cancellation raced it', async () => {
  for (const composite of [false, true]) {
    const controller = new AbortController();
    const cause = new Error('independent failure');
    let thrown;
    const endpoint = model({
      invoke: async (_request, _purpose, signal) => {
        controller.abort();
        thrown = composite ? new AggregateError([new InvocationCancelled(signal), cause]) : cause;
        throw thrown;
      },
    });
    await assert.rejects(endpoint.invoke(request, 'answer', { signal: controller.signal, timeoutMs: 1000 }), (error) => error === thrown && !isInvocationCancelled(error, controller.signal));
  }
});
