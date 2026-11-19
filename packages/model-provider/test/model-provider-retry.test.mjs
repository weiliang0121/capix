import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider, modelReplyText, ProviderError } from '@weiliang0121/capix-model-provider';

const messages = [{ role: 'user', content: 'offline retry fixture' }];
const encoder = new TextEncoder();
const retry = { maxAttempts: 3, delayMs: 0, maxDelayMs: 0 };
const usage = { promptTokens: 4, completionTokens: 2, totalTokens: 6 };
const envelope = (reason = 'stop') => ({ id: 'reply', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: 'winner' }, finish_reason: reason }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
const chunk = (delta, reason = null) => ({ id: 'stream', model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: reason }] });
const event = (value) => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const wire = (text = 'winner', reason = 'stop') => event(chunk({ content: text }, reason)) + event('[DONE]');
const streamResponse = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const provider = (fetcher, configuration = {}) => new ChatCompletionsProvider({ endpoint: 'https://fixture.invalid/chat/completions', apiKey: 'offline-key', model: 'fixture-model', fetch: fetcher, ...configuration });
const isCode = (code) => (error) => error instanceof ProviderError && error.code === code;

function openBody(text = '') {
  let cancelled = 0;
  const body = new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
    },
    cancel() {
      cancelled++;
    },
  });
  return {
    body,
    get cancelled() {
      return cancelled;
    },
  };
}

test('retry is opt-in and maxAttempts includes the initial send', async () => {
  for (const configuration of [{}, { retry: { maxAttempts: 1 } }, { retry }]) {
    let sends = 0;
    const events = [];
    await assert.rejects(
      provider(async () => {
        sends++;
        throw new TypeError('private network detail');
      }, configuration).complete({ messages }, { attempt: (value) => events.push(value) }),
      isCode('NETWORK'),
    );
    const count = configuration.retry?.maxAttempts ?? 1;
    assert.equal(sends, count);
    assert.deepEqual(
      events.filter((value) => value.kind === 'started').map((value) => value.attempt),
      Array.from({ length: count }, (_, index) => index + 1),
    );
    assert.equal(events.filter((value) => value.kind === 'retrying').length, count - 1);
    assert.equal(events.at(-1).kind, 'failed');
    assert.equal(JSON.stringify(events).includes('private network detail'), false);
  }
});

test('retry validates bounded integer settings before transport', () => {
  let sends = 0;
  const fetcher = async () => {
    sends++;
    return Response.json(envelope());
  };
  for (const value of [null, false, 1, {}, { maxAttempts: 0 }, { maxAttempts: -1 }, { maxAttempts: 1.5 }, { maxAttempts: Infinity }, { maxAttempts: Number.MAX_SAFE_INTEGER + 1 }, { maxAttempts: 2, delayMs: -1 }, { maxAttempts: 2, delayMs: 0.5 }, { maxAttempts: 2, delayMs: 2_147_483_648 }, { maxAttempts: 2, maxDelayMs: 2_147_483_648 }, { maxAttempts: 2, maxDelayMs: 999 }, { maxAttempts: 2, delayMs: 2, maxDelayMs: 1 }]) {
    assert.throws(() => provider(fetcher, { retry: value }), isCode('CONFIGURATION'));
  }
  for (const value of [{ maxAttempts: 1 }, { maxAttempts: Number.MAX_SAFE_INTEGER, delayMs: 0, maxDelayMs: 0 }, { maxAttempts: 1, delayMs: 2_147_483_647, maxDelayMs: 2_147_483_647 }]) provider(fetcher, { retry: value });
  assert.equal(sends, 0);
});

test('transport failure followed by success exposes ordered bounded attempt facts', async () => {
  let sends = 0;
  const events = [];
  const reply = await provider(
    async () => {
      if (++sends === 1) throw new TypeError('network');
      return Response.json(envelope());
    },
    { retry },
  ).complete({ messages }, { attempt: (value) => events.push(value) });
  assert.equal(modelReplyText(reply), 'winner');
  assert.deepEqual(events, [
    { kind: 'started', attempt: 1 },
    { kind: 'failed', attempt: 1, failure: { code: 'NETWORK', phase: 'connect' } },
    { kind: 'retrying', attempt: 1, nextAttempt: 2, delayMs: 0 },
    { kind: 'started', attempt: 2 },
    { kind: 'completed', attempt: 2, usage },
  ]);
  assert.ok(events.every(Object.isFrozen));
  assert.ok(Object.isFrozen(events[1].failure));
});

test('only the explicit transient HTTP statuses retry and dispose each response first', async () => {
  for (const status of [408, 429, 500, 502, 503, 504, 400, 401, 403, 404, 409, 422, 501, 505]) {
    let sends = 0;
    const first = openBody('private server body');
    const model = provider(
      async () => {
        if (++sends === 1) return new Response(first.body, { status });
        assert.equal(first.cancelled, 1);
        assert.equal(first.body.locked, false);
        return Response.json(envelope());
      },
      { retry },
    );
    if ([408, 429, 500, 502, 503, 504].includes(status)) {
      assert.equal(modelReplyText(await model.complete({ messages })), 'winner');
      assert.equal(sends, 2);
    } else {
      await assert.rejects(model.complete({ messages }), (error) => error instanceof ProviderError && error.code === 'HTTP' && error.status === status);
      assert.equal(sends, 1);
    }
    assert.equal(first.cancelled, 1);
  }
});

test('a failed response read releases its reader before a new attempt', async () => {
  for (const stream of [false, true]) {
    let sends = 0;
    const events = [];
    const body = new ReadableStream(
      {
        pull(controller) {
          controller.error(new Error('connection lost'));
        },
      },
      { highWaterMark: 0 },
    );
    const reply = await provider(
      async () => {
        if (++sends === 1) return stream ? streamResponse(body) : new Response(body);
        assert.equal(body.locked, false);
        return stream ? streamResponse(wire()) : Response.json(envelope());
      },
      { retry },
    ).complete({ messages, stream }, { attempt: (value) => events.push(value) });
    assert.equal(modelReplyText(reply), 'winner');
    assert.deepEqual(events.find((value) => value.kind === 'failed').failure, { code: 'NETWORK', phase: 'read' });
    assert.equal(sends, 2);
  }
});

test('retry uses the first encoded body and fixed configuration after caller mutations', async () => {
  const request = { messages: [{ role: 'user', content: 'original' }], temperature: 0 };
  const options = { ...retry };
  const bodies = [];
  const model = provider(
    async (_url, init) => {
      bodies.push(init.body);
      if (bodies.length === 1) {
        request.messages[0].content = 'mutated';
        request.temperature = 1;
        options.maxAttempts = 1;
        options.delayMs = 9999;
        throw new Error('retry this transport failure');
      }
      return Response.json(envelope());
    },
    { retry: options },
  );
  await model.complete(request);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]).messages[0].content, 'original');
  assert.equal(JSON.parse(bodies[1]).temperature, 0);
});

test('cut-off SSE attempts can retry while final output contains only the winning reply', async () => {
  let sends = 0;
  let activeAttempt;
  const previews = [];
  const events = [];
  const reply = await provider(async () => (++sends === 1 ? streamResponse(event(chunk({ reasoning_content: 'discarded reasoning', content: 'discarded answer' }))) : streamResponse(wire())), { retry }).complete(
    { messages, stream: true },
    {
      attempt(value) {
        events.push(value);
        if (value.kind === 'started') activeAttempt = value.attempt;
      },
      emit: (text) => previews.push([activeAttempt, 'text', text]),
      emitReasoning: (text) => previews.push([activeAttempt, 'reasoning', text]),
    },
  );
  assert.deepEqual(previews, [
    [1, 'reasoning', 'discarded reasoning'],
    [1, 'text', 'discarded answer'],
    [2, 'text', 'winner'],
  ]);
  assert.deepEqual(events.find((value) => value.kind === 'failed').failure, { code: 'ENVELOPE', phase: 'stream', diagnostic: { protocol: 'chat-completions', phase: 'stream', reason: 'missing-terminal' } });
  assert.equal(modelReplyText(reply), 'winner');
  assert.equal(reply.native.reasoningContent, undefined);
});

test('malformed JSON, UTF-8 and SSE protocol stay terminal even with retry enabled', async () => {
  const cases = [
    [false, 'missing-body', () => new Response(null)],
    [true, 'unexpected-content-type', () => Response.json({})],
    [false, 'invalid-json', () => new Response('not json')],
    [false, 'invalid-utf8', () => new Response(new Uint8Array([255]))],
    [false, 'invalid-envelope', () => Response.json({})],
    [true, 'invalid-json', () => streamResponse('data: not json\n\n')],
    [true, 'invalid-utf8', () => streamResponse(new Uint8Array([255]))],
    [true, 'invalid-envelope', () => streamResponse(event(chunk({ content: 42 })))],
    [true, 'invalid-envelope', () => streamResponse(event('[DONE]'))],
    [true, 'invalid-envelope', () => streamResponse(event(chunk({ content: 'partial' })) + event('[DONE]'))],
    [true, 'invalid-envelope', () => streamResponse(event(chunk({ content: 'first' })) + event({ ...chunk({}, 'stop'), id: 'changed' }))],
  ];
  for (const [stream, reason, response] of cases) {
    let sends = 0;
    await assert.rejects(
      provider(
        async () => {
          sends++;
          return response();
        },
        { retry },
      ).complete({ messages, stream }),
      { code: 'ENVELOPE', diagnostic: { protocol: 'chat-completions', phase: stream ? 'stream' : 'response', reason } },
    );
    assert.equal(sends, 1);
  }
});

test('a caller SyntaxError used to abort during a stream keeps its identity', async () => {
  const controller = new AbortController();
  const reason = new SyntaxError('caller cancellation');
  let sends = 0;
  const model = provider(
    async () => {
      sends++;
      return streamResponse(wire());
    },
    { retry },
  );
  await assert.rejects(model.complete({ messages, stream: true }, { signal: controller.signal, emit: () => controller.abort(reason) }), (error) => error === reason);
  assert.equal(sends, 1);
});

test('valid completed, refused and incomplete replies never trigger another send', async () => {
  for (const stream of [false, true])
    for (const reason of ['stop', 'length', 'content_filter', 'vendor_reason']) {
      let sends = 0;
      const events = [];
      const reply = await provider(
        async () => {
          sends++;
          return stream ? streamResponse(wire('winner', reason)) : Response.json(envelope(reason));
        },
        { retry },
      ).complete({ messages, stream }, { attempt: (value) => events.push(value) });
      assert.equal(sends, 1);
      assert.equal(reply.termination.reason, reason);
      assert.deepEqual(
        events.map((value) => value.kind),
        ['started', 'completed'],
      );
    }
});

async function capturedNetworkFailure() {
  try {
    await provider(async () => {
      throw new Error('transport');
    }).complete({ messages });
  } catch (error) {
    assert.ok(error instanceof ProviderError);
    return error;
  }
  assert.fail('expected transport rejection');
}

test('consumer-thrown real ProviderErrors retain identity and never acquire transport retry provenance', async () => {
  const failure = await capturedNetworkFailure();
  for (const consumer of ['emit', 'emitReasoning', 'progress', 'attempt']) {
    let sends = 0;
    const body = openBody(event(chunk({ reasoning_content: 'reasoning', content: 'answer' }, 'stop')) + event('[DONE]'));
    await assert.rejects(
      provider(
        async () => {
          sends++;
          return streamResponse(body.body);
        },
        { retry },
      ).complete(
        { messages, stream: true },
        {
          [consumer]() {
            throw failure;
          },
        },
      ),
      (error) => error === failure,
    );
    assert.equal(sends, consumer === 'attempt' ? 0 : 1);
    if (consumer !== 'attempt') {
      assert.equal(body.cancelled, 1);
      assert.equal(body.body.locked, false);
    }
  }
});

test('attempt consumers also remain terminal at failed, retrying and completed notifications', async () => {
  const failure = await capturedNetworkFailure();
  for (const kind of ['failed', 'retrying', 'completed']) {
    let sends = 0;
    await assert.rejects(
      provider(
        async () => {
          sends++;
          if (kind !== 'completed') throw new Error('network');
          return Response.json(envelope());
        },
        { retry },
      ).complete(
        { messages },
        {
          attempt(value) {
            if (value.kind === kind) throw failure;
          },
        },
      ),
      (error) => error === failure,
    );
    assert.equal(sends, 1);
  }
});

test('cancellation during the retry wait keeps the caller reason and prevents another send', async () => {
  const caller = new AbortController();
  const reason = new Error('cancel retry wait');
  const waiting = Promise.withResolvers();
  let sends = 0;
  const pending = provider(
    async () => {
      sends++;
      return new Response('', { status: 503 });
    },
    { retry: { maxAttempts: 3, delayMs: 1000 } },
  ).complete(
    { messages },
    {
      signal: caller.signal,
      attempt(value) {
        if (value.kind === 'retrying') waiting.resolve();
      },
    },
  );
  const rejected = assert.rejects(pending, (error) => error === reason);
  await waiting.promise;
  caller.abort(reason);
  await rejected;
  assert.equal(sends, 1);
});

test('cancellation during body reading never retries and releases the reader', async () => {
  for (const stream of [false, true]) {
    const caller = new AbortController();
    const reason = new Error('cancel active read');
    const body = openBody();
    const reading = Promise.withResolvers();
    let sends = 0;
    const pending = provider(
      async () => {
        sends++;
        setImmediate(() => reading.resolve());
        return stream ? streamResponse(body.body) : new Response(body.body);
      },
      { retry },
    ).complete({ messages, stream }, { signal: caller.signal });
    const rejected = assert.rejects(pending, (error) => error === reason);
    await reading.promise;
    caller.abort(reason);
    await rejected;
    assert.equal(sends, 1);
    assert.equal(body.cancelled, 1);
    assert.equal(body.body.locked, false);
  }
});

test('the total timeout includes retry waits instead of granting each attempt a new budget', async () => {
  let sends = 0;
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    await assert.rejects(
      provider(
        async () => {
          sends++;
          return new Response('', { status: 503 });
        },
        { timeoutMs: 15, retry: { maxAttempts: 3, delayMs: 1000 } },
      ).complete({ messages }),
      isCode('TIMEOUT'),
    );
    assert.equal(sends, 1);
  } finally {
    clearTimeout(keepAlive);
  }
});

test('Retry-After is honored within the cap and an excessive hint makes HTTP terminal', async () => {
  for (const [hint, cap, retries, expectedDelay] of [
    ['0', 10, true, 1],
    ['0.003', 10, true, 3],
    ['3600', 10, false],
    ['nonsense', 10, true, 1],
    [new Date(Date.now() + 3_600_000).toUTCString(), 10, false],
  ]) {
    let sends = 0;
    const events = [];
    const model = provider(async () => (++sends === 1 ? new Response('', { status: 429, headers: { 'Retry-After': hint } }) : Response.json(envelope())), { retry: { maxAttempts: 2, delayMs: 1, maxDelayMs: cap } });
    if (retries) {
      await model.complete({ messages }, { attempt: (value) => events.push(value) });
      assert.equal(sends, 2);
      assert.equal(events.find((value) => value.kind === 'retrying').delayMs, expectedDelay);
    } else {
      await assert.rejects(model.complete({ messages }, { attempt: (value) => events.push(value) }), isCode('HTTP'));
      assert.equal(sends, 1);
      assert.equal(
        events.some((value) => value.kind === 'retrying'),
        false,
      );
    }
  }
});

test('response size limits and invalid requests stay terminal with retries enabled', async () => {
  let sends = 0;
  const model = provider(
    async () => {
      sends++;
      return Response.json({ ...envelope(), padding: 'x'.repeat(2000) });
    },
    { retry, maxResponseBytes: 1024 },
  );
  await assert.rejects(model.complete({ messages }), isCode('RESPONSE_LIMIT'));
  assert.equal(sends, 1);
  await assert.rejects(model.complete({ messages: [] }), isCode('REQUEST'));
  assert.equal(sends, 1);
});

test('retry delay defaults and capped exponential growth are visible without long waits', async () => {
  const stop = new Error('observed default retry delay');
  const defaults = [];
  await assert.rejects(
    provider(
      async () => {
        throw new Error('network');
      },
      { retry: { maxAttempts: 2 } },
    ).complete(
      { messages },
      {
        attempt(value) {
          defaults.push(value);
          if (value.kind === 'retrying') throw stop;
        },
      },
    ),
    (error) => error === stop,
  );
  assert.equal(defaults.at(-1).delayMs, 1000);
  let sends = 0;
  const delays = [];
  await assert.rejects(
    provider(
      async () => {
        sends++;
        throw new Error('network');
      },
      { retry: { maxAttempts: 5, delayMs: 1, maxDelayMs: 3 } },
    ).complete(
      { messages },
      {
        attempt(value) {
          if (value.kind === 'retrying') delays.push(value.delayMs);
        },
      },
    ),
    isCode('NETWORK'),
  );
  assert.equal(sends, 5);
  assert.deepEqual(delays, [1, 2, 3, 3]);
  sends = 0;
  await assert.rejects(
    provider(
      async () => {
        sends++;
        return new Response('', { status: 503, headers: { 'Retry-After': '31' } });
      },
      { retry: { maxAttempts: 2 } },
    ).complete({ messages }),
    isCode('HTTP'),
  );
  assert.equal(sends, 1);
});

test('invalid or asynchronous attempt consumers fail before a repeated send', async () => {
  let sends = 0;
  const model = provider(
    async () => {
      sends++;
      return Response.json(envelope());
    },
    { retry },
  );
  for (const attempt of [null, 'callback', 1, {}]) await assert.rejects(model.complete({ messages }, { attempt }), isCode('REQUEST'));
  assert.equal(sends, 0);
  await assert.rejects(
    model.complete(
      { messages },
      {
        async attempt() {
          throw new Error('consumer rejection');
        },
      },
    ),
    (error) => error instanceof TypeError && !(error instanceof ProviderError),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sends, 0);
});

test('a consumer failure stops attempt notifications before a failed observer can replace it', async () => {
  for (const consumer of ['started', 'emit', 'emitReasoning', 'progress']) {
    const original = new Error(`original ${consumer} failure`);
    const replacement = new Error('failed observer must not replace the original');
    const events = [];
    let sends = 0;
    const body = openBody(event(chunk({ reasoning_content: 'reasoning', content: 'answer' }, 'stop')) + event('[DONE]'));
    const controls = {
      attempt(value) {
        events.push(value.kind);
        if (value.kind === 'failed') throw replacement;
        if (consumer === 'started' && value.kind === 'started') throw original;
      },
      ...(consumer === 'started'
        ? {}
        : {
            [consumer]() {
              throw original;
            },
          }),
    };
    await assert.rejects(
      provider(
        async () => {
          sends++;
          return streamResponse(body.body);
        },
        { retry },
      ).complete({ messages, stream: true }, controls),
      (error) => error === original,
    );
    assert.deepEqual(events, ['started']);
    assert.equal(sends, consumer === 'started' ? 0 : 1);
    if (consumer !== 'started') {
      assert.equal(body.cancelled, 1);
      assert.equal(body.body.locked, false);
    }
  }
});

test('completed consumers that throw or cancel do not announce failure or retry after completion', async () => {
  for (const stream of [false, true])
    for (const mode of ['throw', 'abort', 'abort-and-throw']) {
      const caller = new AbortController();
      const failure = new Error('completed consumer failed');
      const reason = new Error('completed consumer cancelled');
      const events = [];
      let sends = 0;
      await assert.rejects(
        provider(
          async () => {
            sends++;
            return stream ? streamResponse(wire()) : Response.json(envelope());
          },
          { retry },
        ).complete(
          { messages, stream },
          {
            signal: caller.signal,
            attempt(value) {
              events.push(value.kind);
              if (value.kind !== 'completed') return;
              if (mode !== 'throw') caller.abort(reason);
              if (mode !== 'abort') throw failure;
            },
          },
        ),
        (error) => error === (mode === 'abort' ? reason : failure),
      );
      assert.deepEqual(events, ['started', 'completed']);
      assert.equal(sends, 1);
    }
});

test('aborted body consumption awaits asynchronous cancellation cleanup before settling', async () => {
  for (const stream of [false, true]) {
    const caller = new AbortController();
    const reason = new Error('abort while reading');
    const reading = Promise.withResolvers();
    const cancelling = Promise.withResolvers();
    const cleanup = Promise.withResolvers();
    let sends = 0;
    let cancels = 0;
    let settled = false;
    const body = new ReadableStream(
      {
        pull() {
          reading.resolve();
        },
        cancel(value) {
          cancels++;
          assert.equal(value, reason);
          cancelling.resolve();
          return cleanup.promise;
        },
      },
      { highWaterMark: 0 },
    );
    const pending = provider(
      async () => {
        sends++;
        return stream ? streamResponse(body) : new Response(body);
      },
      { retry },
    ).complete({ messages, stream }, { signal: caller.signal });
    const outcome = pending.then(
      (value) => {
        settled = true;
        return value;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    const rejected = assert.rejects(outcome, (error) => error === reason);
    try {
      await reading.promise;
      caller.abort(reason);
      await cancelling.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false);
      assert.equal(sends, 1);
    } finally {
      cleanup.resolve();
      await rejected;
    }
    assert.equal(cancels, 1);
    assert.equal(body.locked, false);
    assert.equal(sends, 1);
  }
});
