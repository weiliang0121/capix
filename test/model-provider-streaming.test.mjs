import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider, ProviderError, modelReplyText } from '@weiliang0121/capix-model-provider';

const messages = [{ role: 'user', content: 'Explain this material' }];
const encoder = new TextEncoder();
const usage = { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 };
const chunk = (delta = {}, finishReason = null, fields = {}) => ({ id: 'stream-1', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finishReason }], ...fields });
const event = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const completeStream = (text = 'answer', finishReason = 'stop') => event(chunk({ content: text })) + event(chunk({}, finishReason)) + event('[DONE]');
const provider = (fetcher, configuration = {}) => new ChatCompletionsProvider({ endpoint: 'https://provider.example/chat/completions', apiKey: 'fixture-key', model: 'fixture-model', fetch: fetcher, ...configuration });
const response = (body, headers = {}) => new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', ...headers } });

function fragmented(body, width) {
  const bytes = encoder.encode(body);
  let offset = 0;
  return response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else {
          controller.enqueue(bytes.slice(offset, offset + width));
          offset = Math.min(offset + width, bytes.length);
        }
      },
    }),
  );
}

test('streaming is explicit and returns a complete envelope with final-chunk usage', async () => {
  let sends = 0;
  const deltas = [];
  const model = provider(async (_url, options) => {
    sends++;
    assert.deepEqual(JSON.parse(options.body), { model: 'fixture-model', messages, stream: true, stream_options: { include_usage: true }, max_tokens: 50, response_format: { type: 'text' } });
    assert.equal(options.redirect, 'error');
    return response(event(chunk({ role: 'assistant', content: '' })) + event(chunk({ content: '你好' })) + event(chunk({ content: '世界' }, 'stop', { usage })) + event('[DONE]'));
  });
  const reply = await model.complete({ messages, stream: true, maxTokens: 50, responseFormat: 'text' }, { emit: (text) => deltas.push(text) });
  assert.equal(sends, 1);
  assert.deepEqual(deltas, ['你好', '世界']);
  assert.deepEqual(reply, { formatVersion: 1, id: 'stream-1', model: 'fixture-model', output: [{ kind: 'text', text: '你好世界' }], termination: { kind: 'completed', reason: 'stop' }, native: { format: 'chat-completions', version: 1 }, usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } });
  assert.ok(Object.isFrozen(reply));
  assert.ok(Object.isFrozen(reply.usage));
});

test('SSE framing survives bytewise UTF-8, CRLF, multi-line data and separate final usage', async () => {
  const pretty = JSON.stringify(chunk({ content: '好🌏' }), null, 2)
    .split('\n')
    .map((line) => `data: ${line}\r\n`)
    .join('');
  const wire = '\ufeff: provider heartbeat\r\n\r\n' + event(chunk({ role: 'assistant', content: '', reasoning_content: 'private reasoning' })).replaceAll('\n', '\r\n') + 'event: message\r\nid: ignored-transport-id\r\n' + event(chunk({ content: '你' })).replaceAll('\n', '\r\n') + pretty + '\r\n' + event(chunk({}, 'stop')).replaceAll('\n', '\r') + event({ id: 'stream-1', model: 'fixture-model', choices: [], usage }) + event('[DONE]');
  for (const width of [1, 7, 128]) {
    const deltas = [];
    const reply = await provider(async () => fragmented(wire, width)).complete({ messages, stream: true }, { emit: (text) => deltas.push(text) });
    assert.deepEqual(deltas, ['你', '好🌏']);
    assert.equal(modelReplyText(reply), '你好🌏');
    assert.equal(reply.usage.totalTokens, 15);
  }
});

test('a stream can be consumed without a preview receiver, including empty or length-limited results', async () => {
  for (const [text, finishReason] of [
    ['answer', 'stop'],
    ['', 'stop'],
    ['partial', 'length'],
  ]) {
    const result = await provider(async () => response(completeStream(text, finishReason))).complete({ messages, stream: true });
    assert.equal(modelReplyText(result), text);
    assert.equal(result.termination.reason, finishReason);
    assert.equal(result.usage, null);
  }
});

test('preview arrives before the final envelope and DONE releases a still-open HTTP body', async () => {
  const { promise: preview, resolve: sawPreview } = Promise.withResolvers();
  let controller;
  let cancelled = 0;
  let completed = false;
  const body = new ReadableStream({
    start(stream) {
      controller = stream;
      stream.enqueue(encoder.encode(event(chunk({ content: 'first' }))));
    },
    cancel() {
      cancelled++;
    },
  });
  const result = provider(async () => response(body))
    .complete({ messages, stream: true }, { emit: sawPreview })
    .then((reply) => {
      completed = true;
      return reply;
    });
  assert.equal(await preview, 'first');
  assert.equal(completed, false);
  controller.enqueue(encoder.encode(event(chunk({ content: ' last' }, 'stop')) + event('[DONE]')));
  assert.equal(modelReplyText(await result), 'first last');
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('invalid or incomplete streams fail without fabricating completion or leaking source text', async (t) => {
  const sensitive = 'fixture-sensitive-upstream-text';
  const first = event(chunk({ content: sensitive }));
  const finish = event(chunk({}, 'stop'));
  const done = event('[DONE]');
  const cases = {
    'missing finish reason': first + done,
    'missing DONE': first + finish,
    'empty stream': '',
    'DONE without a result': done,
    'unfinished event': first + finish + 'data: [DONE]',
    'invalid JSON': first + `data: ${sensitive}\n\n`,
    'changed completion ID': first + event(chunk({}, 'stop', { id: 'other' })) + done,
    'changed model': first + event(chunk({}, 'stop', { model: 'other' })) + done,
    'multiple choices': first + event(chunk({}, null, { choices: [chunk().choices[0], chunk().choices[0]] })) + done,
    'nonzero choice': first + event(chunk({}, null, { choices: [{ index: 1, delta: { content: 'other' }, finish_reason: 'stop' }] })) + done,
    'non-text content': first + event(chunk({ content: 42 }, 'stop')) + done,
    'unsupported tool type': first + event(chunk({ tool_calls: [{ index: 0, id: 'tool-1', type: 'computer', function: { name: 'invoke', arguments: '{}' } }] }, 'tool_calls')) + done,
    'legacy function call': first + event(chunk({ function_call: { name: 'invoke', arguments: '{}' } }, 'function_call')) + done,
    'content after finish': first + finish + event(chunk({ content: 'unexpected' })) + done,
    'invalid usage': first + event(chunk({}, 'stop', { usage: { ...usage, completion_tokens: -1 } })) + done,
    'empty choices without usage': first + finish + event({ id: 'stream-1', model: 'fixture-model', choices: [] }) + done,
    'upstream error event': first + event({ error: { message: sensitive } }) + done,
  };
  for (const [name, wire] of Object.entries(cases)) {
    await t.test(name, async () => {
      let sends = 0;
      const model = provider(async () => {
        sends++;
        return response(wire);
      });
      await assert.rejects(model.complete({ messages, stream: true }), (error) => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.code, 'ENVELOPE');
        assert.equal(String(error).includes(sensitive), false);
        assert.equal(JSON.stringify(error).includes(sensitive), false);
        assert.equal(error.cause, undefined);
        return true;
      });
      assert.equal(sends, 1);
    });
  }
});

test('streaming rejects JSON responses and malformed UTF-8 rather than treating them as text deltas', async () => {
  for (const result of [Response.json({ error: 'private body' }), response(new Uint8Array([0xff]))]) {
    await assert.rejects(provider(async () => result).complete({ messages, stream: true }), (error) => error instanceof ProviderError && error.code === 'ENVELOPE');
    assert.equal(result.body.locked, false);
  }
});

test('stream byte limits include ignored SSE comments and cancel incomplete readers', async () => {
  let cancelled = 0;
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(encoder.encode(event(chunk({ content: 'preview' }))));
      stream.enqueue(encoder.encode(`: ${'中'.repeat(700)}\n\n`));
    },
    cancel() {
      cancelled++;
    },
  });
  const deltas = [];
  await assert.rejects(provider(async () => response(body, { 'Content-Length': '1' }), { maxResponseBytes: 1024 }).complete({ messages, stream: true }, { emit: (text) => deltas.push(text) }), (error) => error instanceof ProviderError && error.code === 'RESPONSE_LIMIT');
  assert.deepEqual(deltas, ['preview']);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('cancelling a pending stream preserves the caller reason and releases consumption', async () => {
  const caller = new AbortController();
  const reason = new Error('stop preview consumption');
  const { promise: preview, resolve: sawPreview } = Promise.withResolvers();
  let cancelled = 0;
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(encoder.encode(event(chunk({ content: 'first' }))));
    },
    cancel() {
      cancelled++;
    },
  });
  const pending = provider(async () => response(body)).complete({ messages, stream: true }, { signal: caller.signal, emit: sawPreview });
  const rejected = assert.rejects(pending, (error) => error === reason);
  await preview;
  caller.abort(reason);
  await rejected;
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('continued preview production does not extend the total stream timeout', async () => {
  const caller = new AbortController();
  let timer;
  let cancelled = 0;
  const deltas = [];
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(encoder.encode(event(chunk({ content: 'initial' }))));
      timer = setInterval(() => stream.enqueue(encoder.encode(event(chunk({ content: '.' })))), 5);
    },
    cancel() {
      cancelled++;
      clearInterval(timer);
    },
  });
  try {
    await assert.rejects(provider(async () => response(body), { timeoutMs: 30 }).complete({ messages, stream: true }, { signal: caller.signal, emit: (text) => deltas.push(text) }), (error) => error instanceof ProviderError && error.code === 'TIMEOUT');
    assert.equal(deltas[0], 'initial');
    assert.equal(cancelled, 1);
    assert.equal(caller.signal.aborted, false);
    assert.equal(body.locked, false);
  } finally {
    clearInterval(timer);
  }
});

test('receiver failures retain their exact identity even alongside cancellation and stop later deltas', async () => {
  for (const abort of [false, true]) {
    const caller = new AbortController();
    const failure = new Error('receiver owns this failure');
    const reason = new Error('independent cancellation');
    const deltas = [];
    let cancelled = 0;
    const body = new ReadableStream({
      start(stream) {
        stream.enqueue(encoder.encode(event(chunk({ content: 'first' })) + event(chunk({ content: 'second' }, 'stop')) + event('[DONE]')));
      },
      cancel() {
        cancelled++;
      },
    });
    await assert.rejects(
      provider(async () => response(body)).complete(
        { messages, stream: true },
        {
          signal: caller.signal,
          emit(text) {
            deltas.push(text);
            if (abort) caller.abort(reason);
            throw failure;
          },
        },
      ),
      (error) => error === failure,
    );
    assert.deepEqual(deltas, ['first']);
    assert.equal(cancelled, 1);
    assert.equal(body.locked, false);
  }
});

test('cancellation from a receiver prevents later deltas already buffered in the same body chunk', async () => {
  const caller = new AbortController();
  const reason = new Error('cancel after first preview');
  const deltas = [];
  await assert.rejects(
    provider(async () => response(event(chunk({ content: 'first' })) + event(chunk({ content: 'second' }, 'stop')) + event('[DONE]'))).complete(
      { messages, stream: true },
      {
        signal: caller.signal,
        emit(text) {
          deltas.push(text);
          caller.abort(reason);
        },
      },
    ),
    (error) => error === reason,
  );
  assert.deepEqual(deltas, ['first']);
});

test('asynchronous preview receivers fail the synchronous contract without leaking their rejected promise', async () => {
  let cancelled = 0;
  let received = 0;
  const body = new ReadableStream({
    start(stream) {
      stream.enqueue(encoder.encode(event(chunk({ content: 'first' })) + event(chunk({ content: 'second' }, 'stop')) + event('[DONE]')));
    },
    cancel() {
      cancelled++;
    },
  });
  await assert.rejects(
    provider(async () => response(body)).complete(
      { messages, stream: true },
      {
        async emit() {
          received++;
          throw new Error('receiver promise rejected');
        },
      },
    ),
    (error) => error instanceof TypeError && !(error instanceof ProviderError),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(received, 1);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});

test('an independent stream read failure is not relabelled as simultaneous caller cancellation', async () => {
  const caller = new AbortController();
  const reason = new Error('cancel request');
  const unrelated = new Error('sensitive upstream connection detail');
  const body = new ReadableStream(
    {
      pull(stream) {
        stream.error(unrelated);
        caller.abort(reason);
      },
    },
    { highWaterMark: 0 },
  );
  await assert.rejects(provider(async () => response(body)).complete({ messages, stream: true }, { signal: caller.signal }), (error) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.code, 'ENVELOPE');
    assert.equal(error.cause, undefined);
    assert.equal(String(error).includes(unrelated.message), false);
    return true;
  });
  assert.equal(body.locked, false);
});

test('an emit callback alone does not turn a non-streaming request into a stream', async () => {
  const deltas = [];
  const model = provider(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.stream, false);
    assert.equal(body.stream_options, undefined);
    return Response.json({ id: 'reply-1', model: 'fixture-model', choices: [{ index: 0, message: { content: 'final' }, finish_reason: 'stop' }] });
  });
  assert.equal(modelReplyText(await model.complete({ messages }, { emit: (text) => deltas.push(text) })), 'final');
  assert.deepEqual(deltas, []);
});

test('invalid stream configuration fails before sending', async () => {
  let sends = 0;
  const model = provider(async () => {
    sends++;
    return response(completeStream());
  });
  for (const stream of ['true', 1, null]) await assert.rejects(model.complete({ messages, stream }), (error) => error instanceof ProviderError && error.code === 'REQUEST');
  await assert.rejects(model.complete({ messages, stream: true }, { emit: 'receiver' }));
  assert.equal(sends, 0);
});
