import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { modelReplyText } from '@weiliang0121/capix-model-provider';
import { ProviderError } from '@weiliang0121/capix-model-provider';

const messages = [{ role: 'user', content: '把这段文字翻译成英文' }];

const endpoint = 'https://provider.example/chat/completions';

function envelope(overrides = {}) {
  return {
    id: 'completion-1',
    model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '{"selected":"translate"}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
    ...overrides,
  };
}

function provider(fetcher, options = {}) {
  return new ChatCompletionsProvider({ endpoint, apiKey: 'fixture-key', model: 'fixture-model', fetch: fetcher, ...options });
}

function isProviderError(error) {
  return error instanceof ProviderError && typeof error.code === 'string' && error.code.length > 0;
}

test('model provider sends explicit configuration and returns a provider envelope from an mjs import', async () => {
  let sends = 0;
  const model = provider(
    async (url, options) => {
      sends += 1;
      assert.equal(String(url), endpoint);
      assert.equal(options.method, 'POST');
      const headers = new Headers(options.headers);
      assert.equal(headers.get('authorization'), 'Bearer fixture-key');
      assert.equal(headers.get('content-type'), 'application/json');
      assert.deepEqual(JSON.parse(options.body), { model: 'fixture-model', messages, max_tokens: 128, response_format: { type: 'json_object' }, temperature: 0, thinking: { type: 'disabled' }, stream: false });
      assert.ok(options.signal instanceof AbortSignal);
      return Response.json(envelope());
    },
    { thinking: 'disabled' },
  );
  const result = await model.complete({ messages, maxTokens: 128, responseFormat: 'json_object', temperature: 0 });
  assert.equal(sends, 1);
  assert.deepEqual(result, { formatVersion: 1, id: 'completion-1', model: 'fixture-model', output: [{ kind: 'text', text: '{"selected":"translate"}' }], termination: { kind: 'completed', reason: 'stop' }, native: { format: 'chat-completions', version: 1 }, usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } });
});

test('length and empty content remain visible for business acceptance instead of becoming successful invented text', async () => {
  for (const text of ['', '{"selected":']) {
    const model = provider(async () => Response.json(envelope({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'length' }], usage: null })));
    const result = await model.complete({ messages });
    assert.equal(modelReplyText(result), text);
    assert.equal(result.termination.reason, 'length');
    assert.equal(result.usage, null);
  }
});

test('provider configuration is fixed at construction and request-only values stay separate', async () => {
  const configuration = {
    endpoint,
    apiKey: 'original-key',
    model: 'fixture-model',
    thinking: 'disabled',
    fetch: async (url, options) => {
      assert.equal(String(url), endpoint);
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer original-key');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'fixture-model');
      assert.deepEqual(body.thinking, { type: 'disabled' });
      return Response.json(envelope());
    },
  };
  const model = new ChatCompletionsProvider(configuration);
  configuration.endpoint = 'https://other.example/chat/completions';
  configuration.apiKey = 'replacement-key';
  configuration.model = 'another-model';
  configuration.thinking = 'enabled';
  configuration.fetch = () => {
    throw new Error('must not use changed fetch');
  };
  await model.complete({ messages });
});

test('text mode does not acquire JSON business constraints or provider-specific thinking implicitly', async () => {
  const model = provider(async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.thinking, undefined);
    assert.ok(body.response_format === undefined || body.response_format.type === 'text');
    assert.equal(body.stream, false);
    return Response.json(envelope({ usage: undefined }));
  });
  assert.equal((await model.complete({ messages, responseFormat: 'text' })).usage, null);
});

test('HTTP failures are single-send diagnostics without response bodies, request prompts or credentials', async () => {
  let sends = 0;
  const sensitive = 'fixture-api-key-or-server-body';
  const model = provider(
    async () => {
      sends += 1;
      return new Response(sensitive, { status: 429 });
    },
    { apiKey: sensitive },
  );
  await assert.rejects(model.complete({ messages }), (error) => {
    assert.ok(isProviderError(error));
    assert.equal(error.status, 429);
    assert.equal(JSON.stringify(error).includes(sensitive), false);
    assert.equal(String(error).includes(sensitive), false);
    assert.equal(String(error).includes(messages[0].content), false);
    return true;
  });
  assert.equal(sends, 1);
});

test('malformed provider envelopes are rejected rather than coerced into empty successful completions', async () => {
  const invalid = [null, {}, envelope({ id: '' }), envelope({ model: '' }), envelope({ choices: [] }), envelope({ choices: [envelope().choices[0], envelope().choices[0]] }), envelope({ choices: [{ index: 0, message: { content: 42 }, finish_reason: 'stop' }] }), envelope({ choices: [{ index: 0, message: { content: null }, finish_reason: 'stop' }] }), envelope({ choices: [{ index: 0, message: { content: 'answer' }, finish_reason: null }] }), envelope({ usage: { prompt_tokens: -1, completion_tokens: 1, total_tokens: 0 } }), envelope({ usage: { prompt_tokens: 1.5, completion_tokens: 1, total_tokens: 2.5 } })];
  for (const body of invalid) {
    const model = provider(async () => Response.json(body));
    await assert.rejects(model.complete({ messages }), isProviderError);
  }
});

test('invalid JSON and invalid UTF-8 bodies are rejected', async () => {
  for (const body of ['not-json', new Uint8Array([0xff])]) {
    await assert.rejects(provider(async () => new Response(body)).complete({ messages }), isProviderError);
  }
});

test('pre-cancelled requests preserve the exact caller reason without sending', async () => {
  const reason = new Error('caller cancelled');
  let sends = 0;
  const model = provider(async () => {
    sends += 1;
    return Response.json(envelope());
  });
  await assert.rejects(model.complete({ messages }, { signal: AbortSignal.abort(reason) }), (error) => error === reason);
  assert.equal(sends, 0);
});

test('cancellation during fetch preserves caller reason and does not retry', async () => {
  const controller = new AbortController();
  const reason = new Error('stop this request');
  let sends = 0;
  const model = provider((_url, { signal }) => {
    sends += 1;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('fetch cancelled', 'AbortError')), { once: true });
      controller.abort(reason);
    });
  });
  await assert.rejects(model.complete({ messages }, { signal: controller.signal }), (error) => error === reason);
  assert.equal(sends, 1);
});

test('a concurrent abort does not relabel an independently thrown transport failure', async () => {
  for (const stage of ['fetch', 'body']) {
    const caller = new AbortController();
    const reason = new Error('stop requested');
    const unrelated = new TypeError('fixture-sensitive-transport-detail');
    const model = provider(async () => {
      if (stage === 'fetch') {
        caller.abort(reason);
        throw unrelated;
      }
      return new Response(
        new ReadableStream(
          {
            pull(stream) {
              stream.error(unrelated);
              caller.abort(reason);
            },
          },
          { highWaterMark: 0 },
        ),
      );
    });
    await assert.rejects(model.complete({ messages }, { signal: caller.signal }), (error) => {
      assert.ok(isProviderError(error));
      assert.equal(error.code, stage === 'fetch' ? 'NETWORK' : 'ENVELOPE');
      assert.equal(String(error).includes(unrelated.message), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('cancellation stops pending body consumption and closes its reader', async () => {
  const controller = new AbortController();
  const reason = new Error('stop the body');
  let closed = 0;
  const model = provider(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{'));
            setImmediate(() => controller.abort(reason));
          },
          cancel() {
            closed += 1;
          },
        }),
      ),
  );
  await assert.rejects(model.complete({ messages }, { signal: controller.signal }), (error) => error === reason);
  assert.equal(closed, 1);
});

test('one total timeout covers fetch and body reading without aborting the caller signal', async () => {
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    for (const stage of ['fetch', 'body']) {
      const caller = new AbortController();
      let closed = 0;
      const model = provider(
        (_url, { signal }) =>
          stage === 'fetch'
            ? new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
            : Promise.resolve(
                new Response(
                  new ReadableStream({
                    cancel() {
                      closed += 1;
                    },
                  }),
                ),
              ),
        { timeoutMs: 10 },
      );
      await assert.rejects(model.complete({ messages }, { signal: caller.signal }), isProviderError);
      assert.equal(caller.signal.aborted, false);
      if (stage === 'body') assert.equal(closed, 1);
    }
  } finally {
    clearTimeout(keepAlive);
  }
});

test('actual received bytes enforce the body limit even without an honest content length', async () => {
  let closed = 0;
  const model = provider(
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new TextEncoder().encode(JSON.stringify(envelope({ padding: '中'.repeat(600) }))));
          },
          cancel() {
            closed += 1;
          },
        }),
        { headers: { 'Content-Length': '10' } },
      ),
    { maxResponseBytes: 1024 },
  );
  await assert.rejects(model.complete({ messages }), isProviderError);
  assert.equal(closed, 1);
});

test('invalid inputs fail before fetching and do not inject arbitrary request fields', async () => {
  let sends = 0;
  const model = provider(async () => {
    sends += 1;
    return Response.json(envelope());
  });
  for (const request of [{ messages: [] }, { messages: new Array(1) }, { messages: [{ role: 'tool', content: 'x' }] }, { messages, maxTokens: 0 }, { messages, temperature: Number.NaN }]) {
    await assert.rejects(model.complete(request));
  }
  assert.equal(sends, 0);
});

test('cleanup cancellation does not overwrite an already received HTTP failure', async () => {
  const caller = new AbortController();
  const reason = new Error('cancel during body cleanup');
  const model = provider(
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            caller.abort(reason);
          },
        }),
        { status: 503 },
      ),
  );
  await assert.rejects(model.complete({ messages }, { signal: caller.signal }), (error) => error instanceof ProviderError && error.code === 'HTTP' && error.status === 503);
  assert.equal(caller.signal.aborted, true);
});
