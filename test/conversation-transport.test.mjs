import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import { createYieldingFetch } from '@capix/conversation-service/assembly';
import { ChatCompletionsProvider, ProviderError } from '@capix/model-provider';

const endpoint = 'https://fixture.invalid/chat/completions';
const request = { messages: [{ role: 'user', content: 'hello' }] };
const envelope = { id: 'reply-1', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }], usage: null };

function provider(fetch, options = {}) {
  return new ChatCompletionsProvider({ endpoint, apiKey: 'offline-test', model: 'fixture', fetch, ...options });
}

test('host transport leaves the current promise chain before one dispatch and preserves its response', async () => {
  const events = [];
  const response = Response.json(envelope);
  const options = { method: 'POST', body: 'fixed body', signal: new AbortController().signal };
  const previousTurn = nextTurn().then(() => events.push('scheduled turn'));
  const fetch = createYieldingFetch(async (input, init) => {
    events.push('fetch');
    assert.equal(input, endpoint);
    assert.notEqual(init, options);
    assert.deepEqual(init, options);
    return response;
  });
  const pending = fetch(endpoint, options);
  assert.deepEqual(events, []);
  await Promise.resolve();
  assert.deepEqual(events, []);
  assert.equal(await pending, response);
  await previousTurn;
  assert.deepEqual(events, ['scheduled turn', 'fetch']);
});

test('pre-cancellation and cancellation during the yield preserve the exact reason without sending', async () => {
  for (const preCancelled of [true, false]) {
    const controller = new AbortController();
    const reason = { reason: 'cancel request' };
    let sends = 0;
    const fetch = createYieldingFetch(async () => {
      sends++;
      return Response.json(envelope);
    });
    if (preCancelled) controller.abort(reason);
    const pending = fetch(endpoint, { signal: controller.signal });
    if (!preCancelled) controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(sends, 0);
  }
});

test('Request.signal is used unless init supplies another signal or explicitly null', async () => {
  const controller = new AbortController();
  const reason = new Error('request abort');
  const input = new Request(endpoint, { signal: controller.signal });
  let sends = 0;
  const fetch = createYieldingFetch(async () => {
    sends++;
    return Response.json(envelope);
  });
  const pending = fetch(input);
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(sends, 0);
  await fetch(input, { signal: null });
  await fetch(input, { signal: new AbortController().signal });
  assert.equal(sends, 2);
  const override = new AbortController();
  const overrideReason = new Error('override abort');
  override.abort(overrideReason);
  await assert.rejects(fetch(new Request(endpoint), { signal: override.signal }), (error) => error === overrideReason);
  assert.equal(sends, 2);
});

test('transport errors are delivered unchanged and never retried', async () => {
  const failure = new Error('transport failure');
  let sends = 0;
  const fetch = createYieldingFetch(async () => {
    sends++;
    throw failure;
  });
  await assert.rejects(fetch(endpoint), (error) => error === failure);
  assert.equal(sends, 1);
});

test('changing init.signal during the yield cannot replace the signal checked before dispatch', async () => {
  let sends = 0;
  const controller = new AbortController();
  const reason = new Error('original request cancelled');
  const options = { signal: controller.signal, method: 'POST', body: 'fixed' };
  const fetch = createYieldingFetch(async () => {
    sends++;
    return Response.json(envelope);
  });
  const pending = fetch(endpoint, options);
  options.signal = new AbortController().signal;
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(sends, 0);

  const headers = new Headers({ 'x-test': 'original' });
  const active = new AbortController();
  const initial = { signal: active.signal, method: 'POST', body: 'original', headers };
  const accepted = createYieldingFetch(async (_input, init) => {
    assert.equal(init.signal, active.signal);
    assert.equal(init.method, 'POST');
    assert.equal(init.body, 'original');
    assert.equal(init.headers, headers, 'nested host-owned objects are borrowed');
    return Response.json(envelope);
  })(endpoint, initial);
  initial.signal = controller.signal;
  initial.method = 'DELETE';
  initial.body = 'replacement';
  await accepted;
});

test('host transport fixes its underlying fetch at construction without replacing the global fetch', async (t) => {
  let original = 0;
  let replacement = 0;
  const mocked = t.mock.method(globalThis, 'fetch', async () => {
    original++;
    return Response.json(envelope);
  });
  const fetch = createYieldingFetch();
  assert.equal(globalThis.fetch, mocked);
  globalThis.fetch = async () => {
    replacement++;
    return Response.json(envelope);
  };
  await fetch(endpoint);
  assert.equal(replacement, 0);
  assert.equal(original, 1);
  assert.throws(() => createYieldingFetch(null), TypeError);
});

test('provider cancellation during the host yield preserves reason and prevents the network request', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel before dispatch');
  let sends = 0;
  const model = provider(
    createYieldingFetch(async () => {
      sends++;
      return Response.json(envelope);
    }),
  );
  const pending = model.complete(request, { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(sends, 0);
});

test('provider total timeout already covers the host yield and prevents a timed-out dispatch', async (t) => {
  // Advance only the provider timer. The transport immediate remains real so the
  // timeout can deterministically occur while dispatch is still suspended.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let sends = 0;
  const model = provider(
    createYieldingFetch(async () => {
      sends++;
      return Response.json(envelope);
    }),
    { timeoutMs: 10 },
  );
  const pending = model.complete(request);
  const rejected = assert.rejects(pending, (error) => error instanceof ProviderError && error.code === 'TIMEOUT');
  t.mock.timers.tick(10);
  await rejected;
  assert.equal(sends, 0);
});

test('ordinary provider completion still returns the same accepted model reply through the yielding transport', async () => {
  let sends = 0;
  const model = provider(
    createYieldingFetch(async (_input, options) => {
      sends++;
      assert.equal(JSON.parse(options.body).messages[0].content, 'hello');
      return Response.json(envelope);
    }),
  );
  assert.deepEqual(await model.complete(request), { id: 'reply-1', model: 'fixture', formatVersion: 1, output: [{ kind: 'text', text: 'hello' }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null });
  assert.equal(sends, 1);
});
