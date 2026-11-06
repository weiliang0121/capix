import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createConversationWebHost } from '@capix/conversation-service/web';
import { ConversationStore } from '@capix/conversation-service/persistence';

const reply = (text) => ({ id: 'web-host-test', model: 'fixture', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null });
function provider() {
  let requests = 0;
  return {
    get requests() {
      return requests;
    },
    async complete(input, controls = {}) {
      requests++;
      if (input.responseFormat === 'json_object') return reply('{"changes":[]}');
      controls.emit?.('预览');
      return reply('正式回答');
    },
  };
}
async function listen(host) {
  await new Promise((resolve, reject) => {
    host.server.once('error', reject);
    host.server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${host.server.address().port}`;
}
async function get(origin, path) {
  const response = await fetch(origin + path);
  assert.equal(response.status, 200);
  return response.json();
}
async function submit(origin, conversationId, submissionId, content) {
  const response = await fetch(origin + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ conversationId, submissionId, input: { messages: [{ role: 'user', content }] } }) });
  assert.equal(response.status, 200);
  return (await response.text())
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

test('Web host forwards fixed output limits and reports an exhausted answer without exposing model text', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-web-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = [];
  const model = {
    async complete(request, controls = {}) {
      requests.push(request);
      controls.emit?.('unfinished preview');
      return { ...reply('sensitive model body'), termination: { kind: 'incomplete', reason: 'length' } };
    },
  };
  const host = createConversationWebHost({ database: join(directory, 'budget.sqlite'), mode: 'demo', modelName: 'fixture', model, outputBudget: { answer: 123 } });
  t.after(() => host.close());
  const origin = await listen(host);
  const session = await get(origin, '/api/session');
  const frames = await submit(origin, session.conversationId, 'limited', 'long answer');
  const result = frames.at(-1).change?.result ?? frames.at(-1).submission?.result;
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'MODEL_OUTPUT_LIMIT');
  assert.match(result.error.message, /123 token/);
  assert.doesNotMatch(result.error.message, /sensitive model body/);
  assert.deepEqual(
    requests.map((request) => request.maxTokens),
    [123],
  );
  assert.equal((await get(origin, `/api/transcript?id=${session.transcriptId}`)).messages.length, 1);
});

test('web host serves actual Scene records, reloads saved content and never restores an old submission', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-web-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'conversation.html'), '<!doctype html><p>CAPiX web test</p>');
  const database = join(directory, 'conversation.sqlite');
  const model = provider();
  const options = { database, model, mode: 'demo', modelName: 'fixture', assetsDirectory: directory };
  const first = createConversationWebHost(options);
  t.after(() => first.close());
  const origin = await listen(first);
  assert.match(await (await fetch(origin + '/')).text(), /CAPiX web test/);
  const info = await get(origin, '/api/session');
  assert.equal(info.admission.status, 'ready');
  assert.deepEqual(await get(origin, '/api/recording'), { status: 'idle' });
  const capture = await fetch(origin + '/api/recording/start', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' });
  assert.equal(capture.status, 200);
  assert.equal((await capture.json()).status, 'recording');
  const frames = await submit(origin, info.conversationId, 'first-browser-request', '你好');
  assert.equal(frames.at(-1).submission?.result?.status ?? frames.at(-1).change?.result?.status, 'completed');
  const transcript = await get(origin, `/api/transcript?id=${info.transcriptId}`);
  assert.deepEqual(transcript.messages, [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '正式回答' },
  ]);
  const inspection = await get(origin, '/api/inspection');
  assert.equal(inspection.recording.integrity, 'intact');
  assert.equal(inspection.recording.calls.length, 1);
  assert.equal(inspection.view.members.length, 2);
  const summary = inspection.recording.calls[0];
  assert.equal(summary.input.index, 0);
  assert.equal(summary.answer.index, 1);
  const detail = await get(origin, `/api/calls/${summary.id}`);
  assert.equal(detail.root.structureKind, 'scene');
  assert.equal(detail.root.role, 'conversation');
  assert.equal(detail.root.status, 'succeeded');
  assert.ok(detail.calls.length > 0);
  assert.ok(detail.resources.length > 0);
  assert.equal(detail.transcripts.length, 2);
  assert.ok(!JSON.stringify(detail).includes('预览'));
  assert.equal((await fetch(origin + `/api/calls/${detail.calls[0].id}`)).status, 404, 'only this host root call subtrees can be queried');
  assert.equal(model.requests, 2);
  assert.throws(() => ConversationStore.open(database), /conversation.open/);
  await first.close();
  await first.close();

  const second = createConversationWebHost(options);
  t.after(() => second.close());
  const restarted = await listen(second);
  const next = await get(restarted, '/api/session');
  assert.equal(next.conversationId, info.conversationId);
  assert.equal(next.active, undefined);
  assert.equal((await get(restarted, `/api/transcript?id=${next.transcriptId}`)).messages.length, 2);
  assert.equal((await get(restarted, '/api/inspection')).recording.calls.length, 0);
  assert.equal((await fetch(restarted + '/api/submissions/first-browser-request')).status, 404);
  assert.equal(model.requests, 2, 'opening the service must not issue another model request');
});

test('web host closes local calls before waiting for independent senders and only then releases content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-web-shutdown-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sent = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const database = join(directory, 'conversation.sqlite');
  const model = {
    async complete(_input, controls) {
      sent.resolve(controls);
      await release.promise;
      return reply('late');
    },
  };
  const host = createConversationWebHost({ database, model, mode: 'demo', modelName: 'delayed' });
  t.after(() => host.close());
  const origin = await listen(host);
  const info = await get(origin, '/api/session');
  const received = submit(origin, info.conversationId, 'cancel-on-close', 'hello');
  const controls = await sent.promise;
  assert.equal(controls.signal, undefined, 'HTTP lifetime must not control the independent sender');
  let closed = false;
  const closing = host.close().then(() => {
    closed = true;
  });
  const frames = await received;
  assert.equal(frames.at(-1).change?.result?.status ?? frames.at(-1).submission?.result?.status, 'cancelled');
  assert.equal(closed, false);
  assert.throws(() => ConversationStore.open(database), /conversation.open/);
  release.resolve();
  await closing;
  const store = ConversationStore.open(database);
  try {
    assert.deepEqual(store.load().transcript.messages, [{ role: 'user', content: 'hello' }]);
  } finally {
    store.close();
  }
});
