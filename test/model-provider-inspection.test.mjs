import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ChatCompletionsProvider, ProviderError, requireModelRequest } from '@capix/model-provider';

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
    assert.deepEqual(Object.keys(inspected), ['requestBytes', 'wireBytes']);
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
    requestBytes: Buffer.byteLength(JSON.stringify(request)),
    wireBytes: Buffer.byteLength(JSON.stringify({ model: 'fixture', messages: request.messages, stream: true, stream_options: { include_usage: true } })),
  });
  assert.equal(calls, 0);
});

test('the exact 2 MiB wire boundary is accepted and one additional byte is rejected by both paths', async () => {
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
  assert.throws(() => provider.inspectRequest(request), requestError);
  await assert.rejects(provider.complete(request), requestError);
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
  assert.throws(() => provider.inspectRequest(request), requestError);
  await assert.rejects(provider.complete(request), requestError);
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
    { messages: [{ role: 'user', content: 'x'.repeat(limit) }] },
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
