import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { createConversationWebHost } from '@capix/conversation-service/web';
import { ConversationStore } from '@capix/conversation-service/persistence';

function provider(before = async () => {}) {
  const requests = [];
  const model = new ChatCompletionsProvider({
    endpoint: 'https://fixture.invalid/chat/completions',
    apiKey: 'fixture-only',
    model: 'fixture',
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      await before(request, requests.length);
      const text = request.response_format?.type === 'json_object' ? '{"changes":[]}' : '工具处理后的正式回答';
      const tools = request.tools && !request.messages.some((message) => message.role === 'tool');
      if (request.stream) return new Response(`data: ${JSON.stringify({ id: `response-${requests.length}`, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: `response-${requests.length}`, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      return Response.json({ id: `response-${requests.length}`, model: 'fixture', choices: [{ index: 0, finish_reason: tools ? 'tool_calls' : 'stop', message: tools ? { role: 'assistant', content: null, tool_calls: [{ id: 'search-1', type: 'function', function: { name: 'search_history', arguments: '{"query":"历史"}' } }] } : { role: 'assistant', content: text } }] });
    },
  });
  return { model, requests };
}
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'capix-web-tools-'));
  const database = join(directory, 'conversation.sqlite');
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.close();
    await rm(directory, { recursive: true, force: true });
  });
  async function open(extra = {}) {
    const host = createConversationWebHost({ database, mode: 'demo', modelName: 'fixture', answerMode: 'tools', ...options, ...extra });
    hosts.push(host);
    host.server.listen(0, '127.0.0.1');
    await once(host.server, 'listening');
    const origin = `http://127.0.0.1:${host.server.address().port}`;
    const get = async (path) => {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200);
      return response.json();
    };
    const post = (path, body) => fetch(origin + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const session = await get('/api/session');
    const submit = (id) => post('/api/run', { conversationId: session.conversationId, submissionId: id, input: { messages: [{ role: 'user', content: '查一下以前的历史' }] } });
    return { host, origin, get, post, session, submit };
  }
  return { open, database };
}
const frames = async (response) => {
  assert.equal(response.status, 200);
  return (await response.text()).trim().split('\n').map(JSON.parse);
};
const result = (values) => values.at(-1).change?.result ?? values.at(-1).submission?.result;

test('Web tools mode emits genuine stages without recording or fake text preview and persists isolated archives', async (t) => {
  const model = provider();
  const f = await fixture(t, { model: model.model });
  const web = await f.open();
  assert.equal(web.session.mode, 'demo');
  assert.equal(web.session.answerMode, 'tools');
  assert.deepEqual(await web.get('/api/recording'), { status: 'idle' });
  const all = await frames(await web.submit('tools-one'));
  assert.equal(result(all).status, 'completed', JSON.stringify(all));
  assert.ok(!all.some((frame) => frame.type === 'answer'), 'ToolLoop does not fabricate native tool arguments as answer preview');
  const stages = all.flatMap((frame) => (frame.change?.stage ? [frame.change.stage] : frame.submission?.stage ? [frame.submission.stage] : []));
  assert.deepEqual(
    stages.filter((stage) => stage.status === 'running').map((stage) => stage.kind),
    ['model', 'tool', 'model'],
  );
  assert.equal(stages.find((stage) => stage.kind === 'tool').label, 'search_history');
  assert.ok(!JSON.stringify(stages).includes('arguments'));
  assert.equal((await web.get(`/api/transcript?id=${web.session.transcriptId}`)).messages.at(-1).content, '工具处理后的正式回答');
  assert.equal((await web.get('/api/inspection')).recording.status, 'idle');
  assert.equal(result(await frames(await web.submit('tools-two'))).status, 'completed');
  await web.host.close();
  const store = ConversationStore.open(f.database);
  try {
    assert.equal(store.exchanges.list().items.length, 2);
    assert.ok(store.exchanges.list().items.every((item) => item.metadata && item.entries === 2));
  } finally {
    store.close();
  }
});

test('disconnecting a tools consumer preserves the current stage and follows one existing execution', async (t) => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const model = provider(async (_request, index) => {
    if (index === 1) {
      entered.resolve();
      await gate.promise;
    }
  });
  const f = await fixture(t, { model: model.model });
  const web = await f.open();
  const first = await web.submit('follow-tools');
  await entered.promise;
  const baseline = await web.get('/api/submissions/follow-tools');
  assert.equal(baseline.submission.stage.kind, 'model');
  assert.equal(baseline.submission.stage.status, 'running');
  await first.body.cancel();
  const following = await fetch(web.origin + '/api/submissions/follow-tools/follow');
  gate.resolve();
  const all = await frames(following);
  assert.deepEqual(all[0].submission.stage, baseline.submission.stage);
  assert.equal(result(all).status, 'completed');
  assert.equal(model.requests.length, 3, 'Two model steps and one maintenance request, never a second submission');
});

test('tools cancellation ends the local submission while the late independent feedback is retained', async (t) => {
  const entered = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  const model = provider(async () => {
    entered.resolve();
    await gate.promise;
  });
  const f = await fixture(t, { model: model.model });
  const web = await f.open();
  const first = await web.submit('cancel-tools');
  await entered.promise;
  assert.equal((await web.post('/api/submissions/cancel-tools/cancel', {})).status, 200);
  const all = await frames(first);
  assert.equal(result(all).status, 'cancelled');
  assert.equal((await web.get(`/api/transcript?id=${web.session.transcriptId}`)).messages.length, 1);
  gate.resolve();
  await web.host.close();
  assert.equal(model.requests.length, 1);
  const inspection = new DatabaseSync(f.database, { readOnly: true });
  let interactionId;
  try {
    interactionId = inspection.prepare('SELECT id FROM completion_interactions').get().id;
  } finally {
    inspection.close();
  }
  const store = ConversationStore.open(f.database);
  try {
    assert.ok(store.interactions.read(interactionId).feedback);
    assert.ok(store.archiveUsage().interactionsBytes > 0);
    assert.equal(store.exchanges.list().items.length, 1);
  } finally {
    store.close();
  }
});

test('archive entry rejection keeps material mode history and recovery discovery readable', async (t) => {
  const model = provider();
  const f = await fixture(t, { model: model.model, answerMode: 'material' });
  const first = await f.open();
  assert.equal(result(await frames(await first.submit('seed-material'))).status, 'completed');
  await first.host.close();
  const before = model.requests.length;
  const blocked = await f.open({ archivePolicy: { thresholdBytes: 100, headroomBytes: 1 } });
  assert.equal(blocked.session.admission.status, 'unavailable');
  assert.equal(blocked.session.admission.error.code, 'CONVERSATION_ARCHIVE_FULL');
  assert.equal((await blocked.get(`/api/transcript?id=${blocked.session.transcriptId}`)).messages.length, 2);
  assert.deepEqual(await blocked.get('/api/recoveries'), []);
  const rejected = await frames(await blocked.submit('blocked-entry'));
  assert.equal(result(rejected).status, 'rejected');
  assert.equal(result(rejected).error.code, 'CONVERSATION_ARCHIVE_FULL');
  assert.equal(model.requests.length, before);
});
