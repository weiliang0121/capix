import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { ProviderError, ProviderRequestLimitError, maximumModelExchangeBytes, maximumModelRequestBytes, maximumModelWireRequestBytes, requireModelRequest } from '@weiliang0121/capix-model-provider';

const limit = 2 * 1024 * 1024;

const completed = () => Response.json({ id: 'r', model: 'fixture', choices: [{ index: 0, message: { role: 'assistant', content: 'Done' }, finish_reason: 'stop' }], usage: null });

const configuration = (fetcher, extra = {}) => ({ endpoint: 'https://provider.example/chat/completions', apiKey: 'private-fixture-key', model: 'fixture', fetch: fetcher, ...extra });

const requestError = (error) => error instanceof ProviderError && error.code === 'REQUEST';

test('request inspection is synchronous, frozen and transport-free with exact UTF-8 and escaped JSON sizes', async () => {
  let calls = 0;
  let sent;
  const provider = new ChatCompletionsProvider(
    configuration(async (_url, init) => {
      calls += 1;
      sent = init.body;
      return completed();
    }),
  );
  for (const content of ['hello', '你好🌍', 'quote" slash\\ line\n tab\t nul\u0000', '\ud800', '']) {
    const request = { messages: [{ role: 'user', content }] };
    const before = calls;
    const inspected = provider.inspectRequest(request);
    assert.deepEqual(Object.keys(inspected), ['requestBytes', 'wireBytes', 'limits']);
    assert.ok(Object.isFrozen(inspected));
    assert.equal(inspected.requestBytes, Buffer.byteLength(JSON.stringify(request)));
    assert.equal(calls, before);
    assert.equal(JSON.stringify(inspected).includes('private-fixture-key'), false);
    await provider.complete(request);
    assert.equal(calls, before + 1);
    assert.equal(inspected.wireBytes, Buffer.byteLength(sent));
    assert.equal(sent, JSON.stringify({ model: 'fixture', messages: request.messages, stream: false }));
  }
});

test('inspection and completion use the same fixed configuration, tool exchange and choice encoding', async () => {
  let sent;
  let calls = 0;
  const config = configuration(
    async (_url, init) => {
      calls += 1;
      sent = init.body;
      return completed();
    },
    { model: '固定模型', thinking: 'disabled' },
  );
  const provider = new ChatCompletionsProvider(config);
  config.model = 'changed';
  config.thinking = 'enabled';
  const tool = { name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } };
  const reply = {
    formatVersion: 1,
    id: 'previous',
    model: '固定模型',
    output: [{ kind: 'tool-call', id: 'call-1', name: 'read', arguments: { encoding: 'json-text', text: '{"path":"诗.md"}' } }],
    termination: { kind: 'completed', reason: 'tool_calls' },
    usage: null,
    native: { format: 'chat-completions', version: 1, reasoningContent: '先读\n"文件"' },
  };
  const feedback = { toolCallId: 'call-1', status: 'error', content: [{ kind: 'text', text: '\u0000\n"不存在"\\' }] };
  const request = {
    messages: [{ role: 'user', content: '读取' }],
    tools: [tool],
    toolChoice: { name: 'read' },
    exchanges: [{ reply, feedback: [feedback] }],
    maxTokens: 100,
    temperature: 0,
    responseFormat: 'text',
  };
  const inspected = provider.inspectRequest(request);
  assert.equal(calls, 0);
  assert.equal(inspected.requestBytes, Buffer.byteLength(JSON.stringify(request)));
  await provider.complete(request);
  const expected = JSON.stringify({
    model: '固定模型',
    messages: [...request.messages, { role: 'assistant', content: null, reasoning_content: reply.native.reasoningContent, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: reply.output[0].arguments.text } }] }, { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ status: feedback.status, content: feedback.content }) }],
    stream: false,
    tools: [{ type: 'function', function: tool }],
    tool_choice: { type: 'function', function: { name: 'read' } },
    max_tokens: 100,
    temperature: 0,
    response_format: { type: 'text' },
    thinking: { type: 'disabled' },
  });
  assert.equal(sent, expected);
  assert.equal(inspected.wireBytes, Buffer.byteLength(expected));
  assert.equal(calls, 1);
});

test('inspection includes stream and usage transport fields without performing a stream request', () => {
  let calls = 0;
  const provider = new ChatCompletionsProvider(
    configuration(async () => {
      calls += 1;
      return completed();
    }),
  );
  const request = { messages: [{ role: 'user', content: 'Hello' }], stream: true };
  assert.deepEqual(provider.inspectRequest(request), {
    limits: { maxRequestBytes: limit, maxWireRequestBytes: limit },
    requestBytes: Buffer.byteLength(JSON.stringify(request)),
    wireBytes: Buffer.byteLength(JSON.stringify({ model: 'fixture', messages: request.messages, stream: true, stream_options: { include_usage: true } })),
  });
  assert.equal(calls, 0);
});

test('the exact default wire budget is sent and inspection measures one byte beyond it', async () => {
  let calls = 0;
  let actual;
  const provider = new ChatCompletionsProvider(
    configuration(async (_url, init) => {
      calls += 1;
      actual = Buffer.byteLength(init.body);
      return completed();
    }),
  );
  const request = { messages: [{ role: 'user', content: '' }] };
  request.messages[0].content = 'x'.repeat(limit - provider.inspectRequest(request).wireBytes);
  assert.equal(provider.inspectRequest(request).wireBytes, limit);
  await provider.complete(request);
  assert.equal(actual, limit);
  request.messages[0].content += 'x';
  assert.equal(requireModelRequest(request), request); // The common request still fits; wire overhead does not.
  assert.equal(provider.inspectRequest(request).wireBytes, limit + 1);
  await assert.rejects(provider.complete(request), (error) => error instanceof ProviderRequestLimitError && error.metric === 'wireBytes' && error.bytes === limit + 1 && error.limit === limit);
  assert.equal(calls, 1);
});

test('tool feedback escaping is measured after both JSON encodings and may exceed the wire limit first', async () => {
  let calls = 0;
  const provider = new ChatCompletionsProvider(
    configuration(async () => {
      calls += 1;
      return completed();
    }),
  );
  const reply = {
    formatVersion: 1,
    id: 'previous',
    model: 'fixture',
    output: [{ kind: 'tool-call', id: 'call', name: 'read', arguments: { encoding: 'json-text', text: '{}' } }],
    termination: { kind: 'completed', reason: 'tool_calls' },
    usage: null,
    native: { format: 'chat-completions', version: 1 },
  };
  const request = { messages: [{ role: 'user', content: 'Read' }], exchanges: [{ reply, feedback: [{ toolCallId: 'call', status: 'ok', content: [{ kind: 'text', text: '"'.repeat(600_000) }] }] }] };
  assert.equal(requireModelRequest(request), request);
  assert.ok(provider.inspectRequest(request).wireBytes > limit);
  await assert.rejects(provider.complete(request), (error) => error instanceof ProviderRequestLimitError && error.metric === 'wireBytes');
  assert.equal(calls, 0);
});

test('inspection rejects hostile or excessive values without getters, transport or leaked input', async () => {
  let calls = 0;
  let getters = 0;
  const provider = new ChatCompletionsProvider(
    configuration(async () => {
      calls += 1;
      return completed();
    }),
  );
  const getter = {
    get messages() {
      getters += 1;
      throw new Error('secret getter data');
    },
  };
  const invalid = [
    getter,
    new Proxy(
      {},
      {
        get() {
          getters += 1;
          throw new Error('secret proxy data');
        },
      },
    ),
    { messages: [{ role: 'user', content: 'x'.repeat(maximumModelRequestBytes) }] },
    { messages: [{ role: 'user', content: 'ok' }], extra: 'secret-content' },
  ];
  for (const request of invalid) {
    assert.throws(
      () => provider.inspectRequest(request),
      (error) => requestError(error) && !String(error).includes('secret'),
    );
    await assert.rejects(provider.complete(request), requestError);
  }
  assert.equal(calls, 0);
  assert.equal(getters, 0);
});

test('inspection does not grant future send permission or modify the request', async () => {
  let calls = 0;
  const provider = new ChatCompletionsProvider(
    configuration(async () => {
      calls += 1;
      return completed();
    }),
  );
  const request = { messages: [{ role: 'user', content: 'before' }] };
  const original = structuredClone(request);
  const inspected = provider.inspectRequest(request);
  assert.deepEqual(request, original);
  assert.equal(Object.isFrozen(request), false);
  request.messages[0].role = 'tool';
  await assert.rejects(provider.complete(request), requestError);
  assert.equal(calls, 0);
  assert.equal(inspected.requestBytes, Buffer.byteLength(JSON.stringify(original)));
});

test('request budgets are fixed, positive supported integers and inspection always reports both limits', () => {
  for (const field of ['maxRequestBytes', 'maxWireRequestBytes']) {
    for (const value of [0, -1, 1.5, NaN, Infinity, '1024', null, maximumModelRequestBytes + 1]) {
      assert.throws(
        () => new ChatCompletionsProvider(configuration(async () => completed(), { [field]: value })),
        (error) => error.code === 'CONFIGURATION',
      );
    }
  }
  const config = configuration(async () => completed(), { maxRequestBytes: 100, maxWireRequestBytes: 200 });
  const provider = new ChatCompletionsProvider(config);
  config.maxRequestBytes = 1;
  config.maxWireRequestBytes = 1;
  const inspection = provider.inspectRequest({ messages: [{ role: 'user', content: '你好' }] });
  assert.deepEqual(inspection.limits, { maxRequestBytes: 100, maxWireRequestBytes: 200 });
  assert.ok(Object.isFrozen(inspection.limits));
});

test('common request budget is enforced independently and never exposes request content', async () => {
  let sends = 0;
  const provider = new ChatCompletionsProvider(
    configuration(
      async () => {
        sends++;
        return completed();
      },
      { maxRequestBytes: 100, maxWireRequestBytes: maximumModelWireRequestBytes },
    ),
  );
  const request = { messages: [{ role: 'user', content: 'private-content 你好\\\n"'.repeat(10) }] };
  const inspection = provider.inspectRequest(request);
  assert.ok(inspection.requestBytes > 100);
  await assert.rejects(provider.complete(request), (error) => {
    assert.ok(error instanceof ProviderRequestLimitError && error instanceof ProviderError);
    assert.equal(error.code, 'REQUEST_LIMIT');
    assert.equal(error.metric, 'requestBytes');
    assert.equal(error.bytes, inspection.requestBytes);
    assert.equal(error.limit, 100);
    assert.equal(JSON.stringify(error).includes('private-content'), false);
    assert.equal(String(error).includes('private-content'), false);
    return true;
  });
  assert.equal(sends, 0);
});

test('hosts can raise both budgets for Chinese and escaped text above the default budget', async () => {
  let sent;
  const provider = new ChatCompletionsProvider(
    configuration(
      async (_url, init) => {
        sent = init.body;
        return completed();
      },
      { maxRequestBytes: 4 * limit, maxWireRequestBytes: 4 * limit },
    ),
  );
  const request = { messages: [{ role: 'user', content: '你好"\\\n'.repeat(300_000) }] };
  const inspection = provider.inspectRequest(request);
  assert.ok(inspection.requestBytes > limit);
  await provider.complete(request);
  assert.equal(inspection.requestBytes, Buffer.byteLength(JSON.stringify(request)));
  assert.equal(inspection.wireBytes, Buffer.byteLength(sent));
});

test('common request support ends at exactly 64 MiB independently of the send budgets', () => {
  assert.equal(maximumModelRequestBytes, 64 * 1024 * 1024);
  const request = { messages: [{ role: 'user', content: '' }] };
  request.messages[0].content = 'x'.repeat(maximumModelRequestBytes - Buffer.byteLength(JSON.stringify(request)));
  assert.equal(requireModelRequest(request), request);
  request.messages[0].content += 'x';
  assert.throws(() => requireModelRequest(request), TypeError);
});

test('wire support ends at exactly 64 MiB and oversized wire bodies never reach transport', async () => {
  assert.equal(maximumModelWireRequestBytes, 64 * 1024 * 1024);
  let sentBytes;
  let sends = 0;
  const provider = new ChatCompletionsProvider(
    configuration(
      async (_url, init) => {
        sends++;
        sentBytes = Buffer.byteLength(init.body);
        return completed();
      },
      { maxRequestBytes: maximumModelRequestBytes, maxWireRequestBytes: maximumModelWireRequestBytes },
    ),
  );
  const request = { messages: [{ role: 'user', content: '' }] };
  request.messages[0].content = 'x'.repeat(maximumModelWireRequestBytes - provider.inspectRequest(request).wireBytes);
  assert.equal(provider.inspectRequest(request).wireBytes, maximumModelWireRequestBytes);
  await provider.complete(request);
  assert.equal(sentBytes, maximumModelWireRequestBytes);
  request.messages[0].content += 'x';
  assert.equal(requireModelRequest(request), request);
  assert.throws(() => provider.inspectRequest(request), requestError);
  await assert.rejects(provider.complete(request), requestError);
  assert.equal(sends, 1);
});

test('larger requests retain the independent 2 MiB reply, feedback and exchange support bounds', () => {
  assert.equal(maximumModelExchangeBytes, 2 * 1024 * 1024);
  const provider = new ChatCompletionsProvider(configuration(async () => completed(), { maxRequestBytes: maximumModelRequestBytes, maxWireRequestBytes: maximumModelWireRequestBytes }));
  const reply = { formatVersion: 1, id: 'previous', model: 'fixture', output: [{ kind: 'tool-call', id: 'call', name: 'read', arguments: { encoding: 'json-text', text: '{}' } }], termination: { kind: 'completed', reason: 'tool_calls' }, usage: null, native: { format: 'chat-completions', version: 1 } };
  const feedback = { toolCallId: 'call', status: 'ok', content: [{ kind: 'text', text: '' }] };
  const request = { messages: [{ role: 'user', content: 'Read' }], exchanges: [{ reply, feedback: [feedback] }] };
  for (const kind of ['reply', 'feedback', 'exchange']) {
    reply.native.reasoningContent = kind === 'reply' ? 'x'.repeat(limit) : kind === 'exchange' ? 'x'.repeat(limit / 2) : '';
    feedback.content[0].text = kind === 'feedback' ? 'x'.repeat(limit) : kind === 'exchange' ? 'x'.repeat(limit / 2) : '';
    assert.throws(() => requireModelRequest(request), TypeError);
    assert.throws(() => provider.inspectRequest(request), requestError);
  }
  // Multiple individually bounded exchanges may jointly exceed 2 MiB.
  reply.native.reasoningContent = '';
  feedback.content[0].text = 'x'.repeat(limit / 2);
  request.exchanges = [request.exchanges[0], request.exchanges[0], request.exchanges[0]];
  assert.equal(requireModelRequest(request), request);
  assert.ok(provider.inspectRequest(request).requestBytes > limit);
});
