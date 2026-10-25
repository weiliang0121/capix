import { bindResources } from '../fixtures/resources.mjs';
import { invocationResourceFailures } from '@capix/server-runtime/construction';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgressChannel, isInvocationCancelled } from '@capix/server-runtime';

import { DeepSeekProvider, ModelInteractions, ModelSource, ModelResource, modelInteractionContract } from '@capix/observer-service';

const request = { model: 'fixture', messages: [], response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 256, stream: true };
const output = (content) => ({ id: 'reply', model: 'fixture', content, finishReason: 'stop', usage: null });
const chunk = (text, finish = null, extra = {}) => ({ id: 'reply', model: 'fixture', choices: [{ index: 0, delta: text === undefined ? {} : { content: text }, finish_reason: finish }], ...extra });
const frame = (value, ending = '\n') => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}${ending}${ending}`;

function streamResponse(text, width = 1024) {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset < bytes.length) {
          controller.enqueue(bytes.slice(offset, offset + width));
          offset += width;
        } else controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}

function deferred() {
  let resolve;
  const promise = new Promise((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test('provider consumes arbitrary UTF-8/SSE boundaries and assembles one final envelope', async () => {
  const received = [];
  const content = ['{"content":"你好', '😀\\n世界"}'];
  const usage = { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 };
  const text = ': keepalive\r\n\r\n' + frame(chunk(undefined), '\r\n') + content.map((value) => frame(chunk(value), '\r\n')).join('') + frame(chunk('', 'stop', { usage }), '\r\n') + frame('[DONE]', '\r\n');
  let sends = 0;
  const provider = new DeepSeekProvider('fixture-key', async (_url, init) => {
    sends += 1;
    assert.equal(JSON.parse(init.body).stream, true);
    return streamResponse(text, 1);
  });
  const result = await provider.invoke(
    request,
    'answer',
    new AbortController().signal,
    new ProgressChannel({
      receive: (delta) => {
        received.push(delta);
      },
    }),
  );
  assert.equal(sends, 1);
  assert.deepEqual(
    received,
    content.map((text) => ({ text })),
  );
  assert.equal(result.content, content.join(''));
  assert.equal(result.finishReason, 'stop');
  assert.deepEqual(result.usage, { promptTokens: 12, completionTokens: 7, totalTokens: 19 });
});

test('provider supports multiline data records, CR endings and trailing usage-only chunks', async () => {
  const first =
    JSON.stringify(chunk('body'), null, 2)
      .split('\n')
      .map((line) => `data: ${line}\r`)
      .join('') + '\r';
  const usage = { id: 'reply', model: 'fixture', choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  const provider = new DeepSeekProvider('fixture', async () => streamResponse(first + frame(chunk(undefined, 'length'), '\r') + frame(usage, '\r') + frame('[DONE]', '\r'), 3));
  const result = await provider.invoke(request, 'answer', new AbortController().signal);
  assert.equal(result.content, 'body');
  assert.equal(result.finishReason, 'length');
  assert.equal(result.usage.totalTokens, 2);
});

test('a failed passive consumer never rejects or truncates the provider result', async () => {
  let receives = 0;
  const progress = new ProgressChannel({
    receive: () => {
      receives += 1;
      throw new Error('consumer failed');
    },
  });
  const provider = new DeepSeekProvider('fixture', async () => streamResponse(frame(chunk('a')) + frame(chunk('b', 'stop')) + frame('[DONE]')));
  assert.equal((await provider.invoke(request, 'answer', new AbortController().signal, progress)).content, 'ab');
  assert.equal(receives, 1);
  assert.equal(progress.failure.error.message, 'consumer failed');
});

test('stream EOF, early DONE, malformed envelopes and conflicting identity cannot become complete feedback', async () => {
  const cases = [
    [frame(chunk('partial')), 'PROVIDER_STREAM_INCOMPLETE'],
    [frame(chunk('partial', 'stop')), 'PROVIDER_STREAM_INCOMPLETE'],
    [frame(chunk('partial')) + frame('[DONE]'), 'PROVIDER_STREAM_INCOMPLETE'],
    [frame('not json'), 'PROVIDER_ENVELOPE'],
    [frame(chunk('first')) + frame(chunk('second', 'stop', { id: 'different' })) + frame('[DONE]'), 'PROVIDER_STREAM_IDENTITY'],
    [frame(chunk('first', 'stop')) + frame(chunk('late')) + frame('[DONE]'), 'PROVIDER_ENVELOPE'],
    [frame({ ...chunk('x'), choices: [{ index: 1, delta: { content: 'x' }, finish_reason: 'stop' }] }) + frame('[DONE]'), 'PROVIDER_ENVELOPE'],
  ];
  for (const [text, code] of cases) {
    const provider = new DeepSeekProvider('fixture', async () => streamResponse(text));
    await assert.rejects(provider.invoke(request, 'answer', new AbortController().signal), { code });
  }
});

test('stream capacity is finite and reader cleanup does not replace the original failure', async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(1024 * 1024)));
    },
    cancel() {
      cancelled = true;
      throw new Error('cleanup failed');
    },
  });
  const provider = new DeepSeekProvider('fixture', async () => new Response(body));
  await assert.rejects(provider.invoke(request, 'answer', new AbortController().signal), { code: 'PROVIDER_STREAM_LIMIT' });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('stream abort cancels a pending body read and preserves exact cancellation identity', async () => {
  const control = new AbortController();
  const ready = deferred();
  let cancelled = false;
  const body = new ReadableStream({
    pull() {
      ready.resolve();
    },
    cancel() {
      cancelled = true;
    },
  });
  const provider = new DeepSeekProvider('fixture', async () => new Response(body));
  const running = provider.invoke(request, 'answer', control.signal);
  const rejected = assert.rejects(running, (error) => isInvocationCancelled(error, control.signal) && error.cause === control.signal.reason);
  await ready.promise;
  control.abort(new Error('stop'));
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('host replays a prefix and keeps one raw-progress route across expired A waits and saves one final reply', async () => {
  const first = deferred();
  const finish = deferred();
  const events = [];
  const states = [];
  let sends = 0;
  let producer;
  const host = new ModelInteractions(
    new ModelSource({
      invoke: async (_request, _purpose, _signal, progress) => {
        sends += 1;
        producer = progress;
        progress.publish({ text: 'early' });
        first.resolve();
        await finish.promise;
        progress.publish({ text: 'late' });
        return output('earlylate');
      },
    }),
    {
      persistence: {
        create(state) {
          states.push(state);
        },
        commit({ state }) {
          states.push(state);
        },
        read() {},
      },
    },
  );
  const signal = new AbortController().signal;
  const ref = host.start(request, 'answer', { timeoutMs: 1000 });
  await first.promise;
  const close = host.subscribe(ref, {
    receive: (delta) => {
      events.push(delta);
    },
  });
  assert.deepEqual(events, [{ text: 'early' }]);
  assert.equal((await host.wait(ref, { signal, waitMs: 1 })).kind, 'pending');
  const reading = host.result(ref, { signal });
  finish.resolve();
  assert.equal((await reading).content, 'earlylate');
  assert.equal(sends, 1);
  assert.deepEqual(events, [{ text: 'early' }, { text: 'late' }]);
  assert.equal(states.filter((state) => state.feedback).length, 1);
  producer.publish({ text: 'after completion' });
  assert.equal(events.length, 2);
  const replay = [];
  host.subscribe(ref, {
    receive: (delta) => {
      replay.push(delta);
    },
  })();
  assert.deepEqual(replay, [{ text: 'earlylate' }]);
  close();
  host.close();
});

test('raw prefix capacity and subscriber failure do not reject the independently saved final reply', async () => {
  const start = deferred();
  const signal = new AbortController().signal;
  let consumerCalls = 0;
  const failures = [];
  const host = new ModelInteractions(
    new ModelSource({
      invoke: async (_request, _purpose, _signal, progress) => {
        await start.promise;
        progress.publish({ text: 'first' });
        progress.publish({ text: 'x'.repeat(4 * 1024 * 1024) });
        return output('final');
      },
    }),
  );
  const ref = host.start(request, 'answer', { timeoutMs: 1000 });
  host.subscribe(ref, {
    receive: () => {
      consumerCalls += 1;
      throw new Error('consumer failed');
    },
  });
  host.subscribe(ref, {
    receive: () => {},
    failed: (error) => {
      failures.push(error.code);
    },
  });
  start.resolve();
  assert.equal((await host.result(ref, { signal })).content, 'final');
  assert.equal(consumerCalls, 1);
  assert.deepEqual(failures, ['MODEL_STREAM_LIMIT']);
  host.subscribe(ref, {
    receive: () => {
      assert.fail('failed source must not replay a prefix');
    },
    failed: (error) => {
      failures.push(error.code);
    },
  })();
  assert.deepEqual(failures, ['MODEL_STREAM_LIMIT', 'MODEL_STREAM_LIMIT']);
  host.close();
});

test('stream requests restore through the same persisted interaction contract as legacy nonstream requests', () => {
  for (const stream of [false, true]) {
    const fixed = { request: { ...request, stream }, purpose: 'answer', timeoutMs: 1000 };
    assert.deepEqual(modelInteractionContract.request(fixed), fixed);
  }
});

test('strict subscribe-return observation failure detaches the registered consumer before ownership escapes', async () => {
  const first = deferred();
  const finish = deferred();
  const events = [];
  const failure = new Error('returned observation failed');
  const host = new ModelInteractions(
    new ModelSource({
      invoke: async (_request, _purpose, _signal, progress) => {
        progress.publish({ text: 'first' });
        first.resolve();
        await finish.promise;
        progress.publish({ text: 'later' });
        return output('firstlater');
      },
    }),
  );
  const signal = new AbortController().signal;
  const ref = host.start(request, 'answer', { timeoutMs: 1000 });
  await first.promise;
  const binding = bindResources({ reader: ModelResource.read.request() }, [ModelResource.read.provide(() => host)])(null);
  binding.attach({
    failures: invocationResourceFailures,
    contextId: 'owner',
    validate() {},
    observation: {
      publish(fact) {
        if (fact.phase === 'returned') return failure;
      },
    },
  });
  binding.start();
  assert.throws(
    () =>
      binding.values.reader.subscribe(ref, {
        receive: (delta) => {
          events.push(delta.text);
        },
      }),
    (error) => error === failure,
  );
  assert.deepEqual(events, ['first']);
  finish.resolve();
  assert.equal((await host.result(ref, { signal })).content, 'firstlater');
  assert.deepEqual(events, ['first']);
  host.close();
});

test('host stream timeout is unavailable rather than a partial reply', async () => {
  const signal = new AbortController().signal;
  const provider = new DeepSeekProvider(
    'fixture',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(frame(chunk('partial'))));
          },
        }),
      ),
  );
  const host = new ModelInteractions(new ModelSource(provider));
  const ref = host.start(request, 'answer', { timeoutMs: 1 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(host.result(ref, { signal }), { code: 'MODEL_TIMEOUT' });
    assert.equal(host.states()[0].feedback, undefined);
    assert.equal(host.states()[0].failure.code, 'MODEL_TIMEOUT');
  } finally {
    clearTimeout(keepAlive);
    await host.settled();
    host.close();
  }
});
