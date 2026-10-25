import { bindResources } from '../fixtures/resources.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { InvocationCancelled, isInvocationCancelled } from '@capix/server-runtime';

import { DeepSeekProvider, ModelResource, ModelSource, ModelInteractions } from '@capix/observer-service';

const request = { model: 'fixture', messages: [], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 1, stream: false };
const output = { id: 'fixture', model: 'fixture', content: '{}', finishReason: 'stop', usage: null };
function model(provider) {
  const interactions = new ModelInteractions(new ModelSource(provider));
  const resources = bindResources({ creator: ModelResource.create.request(), reader: ModelResource.read.request() }, [ModelResource.create.provide(() => interactions), ModelResource.read.provide(() => interactions)])(null).values;
  return { interactions, invoke: (request, purpose, controls) => resources.reader.result(resources.creator.start(request, purpose, { timeoutMs: controls.timeoutMs }), controls) };
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

test('model resource cancellation uses the reader signal without aborting provider work', async () => {
  const controller = new AbortController();
  let external;
  const endpoint = model({
    invoke: async (_request, _purpose, signal) => {
      external = signal;
      controller.abort();
      return output;
    },
  });
  await assert.rejects(endpoint.invoke(request, 'answer', { signal: controller.signal, timeoutMs: 1000 }), (error) => isInvocationCancelled(error, controller.signal));
  await endpoint.interactions.settled();
  assert.notEqual(external, controller.signal);
  assert.equal(external.aborted, false);
  assert.deepEqual(endpoint.interactions.states()[0].feedback.payload, output);
  endpoint.interactions.close();
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

test('an already available interaction failure takes precedence over a cancelled reader', async () => {
  for (const composite of [false, true]) {
    const controller = new AbortController();
    const cause = new Error('independent failure');
    const external = AbortSignal.abort(new Error('independent provider stop'));
    const thrown = composite ? new AggregateError([new InvocationCancelled(external), cause]) : cause;
    const host = new ModelInteractions(
      new ModelSource({
        invoke: async () => {
          throw thrown;
        },
      }),
    );
    const ref = host.start(request, 'answer', { timeoutMs: 1000 });
    await host.settled();
    controller.abort();
    for (const method of ['wait', 'result']) {
      await assert.rejects(method === 'wait' ? host.wait(ref, { signal: controller.signal, waitMs: 10 }) : host.result(ref, { signal: controller.signal }), (error) => error === thrown && !isInvocationCancelled(error, controller.signal));
    }
    host.close();
  }
});

test('a later independent failure is retained without reviving a cancelled wait', async () => {
  let fail;
  const response = new Promise((_resolve, reject) => {
    fail = reject;
  });
  const controller = new AbortController();
  const cause = new Error('late provider failure');
  const host = new ModelInteractions(new ModelSource({ invoke: () => response }));
  const ref = host.start(request, 'answer', { timeoutMs: 1000 });
  const waiting = assert.rejects(host.result(ref, { signal: controller.signal }), (error) => isInvocationCancelled(error, controller.signal));
  controller.abort();
  await waiting;
  assert.equal(host.active, true);
  fail(cause);
  await host.settled();
  await assert.rejects(host.result(ref, { signal: new AbortController().signal }), (error) => error === cause);
  host.close();
});
