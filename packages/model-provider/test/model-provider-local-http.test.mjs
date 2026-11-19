import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { AnthropicMessagesProvider, ChatCompletionsProvider, GeminiGenerateContentProvider, OpenAIResponsesProvider, modelReplyText } from '@weiliang0121/capix-model-provider';

test('the default fetch transport sends all four protocols to a loopback HTTP server without vendor credentials', async () => {
  const received = [];
  const envelope = { type: 'message', id: 'local-1', model: 'offline', role: 'assistant', content: [], stop_reason: null };
  const events = [{ type: 'message_start', message: envelope }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '离线' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }];
  const server = createServer(async (req, res) => {
    const body = [];
    for await (const bytes of req) body.push(bytes);
    received.push({ path: req.url, method: req.method, headers: req.headers, body: Buffer.concat(body) });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'local-1', model: 'offline', choices: [{ message: { role: 'assistant', content: '离线' }, finish_reason: 'stop' }] }));
    } else if (req.url === '/v1/messages') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      res.end();
    } else if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'response', id: 'resp_local', model: 'offline', status: 'completed', store: false, previous_response_id: null, error: null, incomplete_details: null, output: [{ type: 'message', id: 'msg_local', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '离线', annotations: [] }] }] }));
    } else if (req.url === '/proxy/v1beta/models/offline:streamGenerateContent?alt=sse') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [text, finishReason] of [
        ['离', undefined],
        ['线', 'STOP'],
      ]) {
        const candidate = { index: 0, content: { role: 'model', parts: [{ text }] }, finishReason };
        res.write(`data: ${JSON.stringify({ responseId: 'google-local-1', modelVersion: 'offline', candidates: [candidate] })}\n\n`);
      }
      res.end();
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const baseUrl = 'http://127.0.0.1:' + server.address().port;
    const common = { model: 'offline', apiKey: 'only-for-the-local-fixture', timeoutMs: 5000 };
    const chat = new ChatCompletionsProvider({ ...common, endpoint: baseUrl + '/v1/chat/completions' });
    const messages = new AnthropicMessagesProvider({ ...common, endpoint: baseUrl + '/v1/messages', anthropicVersion: '2023-06-01', bindingId: 'loopback', maxTokens: 128 });
    const request = { messages: [{ role: 'user', content: '本地' }] };
    const streaming = { ...request, stream: true };
    assert.equal(modelReplyText(await chat.complete(request)), '离线');
    assert.equal(modelReplyText(await messages.complete(streaming)), '离线');
    const responses = new OpenAIResponsesProvider({ ...common, endpoint: baseUrl + '/v1/responses', bindingId: 'loopback' });
    assert.equal(modelReplyText(await responses.complete(request)), '离线');
    const gemini = new GeminiGenerateContentProvider({ ...common, bindingId: 'loopback', endpoint: baseUrl + '/proxy/v1beta/models/offline:generateContent' });
    assert.equal(modelReplyText(await gemini.complete(streaming)), '离线');
    const [first, second, third, fourth] = received;
    assert.deepEqual(
      received.map((item) => [item.method, item.path]),
      [
        ['POST', '/v1/chat/completions'],
        ['POST', '/v1/messages'],
        ['POST', '/v1/responses'],
        ['POST', '/proxy/v1beta/models/offline:streamGenerateContent?alt=sse'],
      ],
    );
    assert.equal(first.headers.authorization, 'Bearer ' + common.apiKey);
    assert.equal(first.headers['x-api-key'], undefined);
    assert.equal(second.headers.authorization, undefined);
    assert.equal(second.headers['x-api-key'], common.apiKey);
    assert.equal(second.headers['anthropic-version'], '2023-06-01');
    assert.equal(first.body.length, chat.inspectRequest(request).wireBytes);
    assert.equal(second.body.length, messages.inspectRequest(streaming).wireBytes);
    assert.equal(third.headers.authorization, 'Bearer ' + common.apiKey);
    assert.equal(third.body.length, responses.inspectRequest(request).wireBytes);
    assert.equal(JSON.parse(third.body).store, false);
    assert.equal(fourth.headers['x-goog-api-key'], common.apiKey);
    assert.equal(fourth.headers.authorization, undefined);
    assert.equal(fourth.body.length, gemini.inspectRequest(streaming).wireBytes);
    assert.deepEqual(JSON.parse(fourth.body).contents, [{ role: 'user', parts: [{ text: '本地' }] }]);
    assert.deepEqual(JSON.parse(first.body).messages, request.messages);
    assert.equal(JSON.parse(second.body).max_tokens, 128);
  } finally {
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
});
