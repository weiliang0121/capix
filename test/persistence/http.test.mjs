import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteObserverStore, ObserverConversations, createObserverServer } from '@capix/observer-service';
import { validateExecutionRecordSnapshot } from '@capix/protocol';
import { submissionSnapshots } from '../fixtures/submissions.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-http-persistence-'));
  const path = join(directory, 'observer.sqlite');
  const running = [];
  t.after(async () => {
    for (const item of running) await item.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    async start() {
      let calls = 0;
      const store = SqliteObserverStore.open(path);
      const conversations = new ObserverConversations(
        {
          async invoke(_request, purpose) {
            ++calls;
            return { id: 'fixture', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: '回答' } : { memories: [] }), finishReason: 'stop', usage: null };
          },
        },
        [],
        { persistence: store },
      );
      const observer = conversations.open(conversations.list().defaultConversationId);
      const server = createObserverServer({ conversations, settings, configured: true });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      let closed = false;
      const item = {
        observer,
        get calls() {
          return calls;
        },
        base: `http://127.0.0.1:${server.address().port}`,
        async close() {
          if (closed) return;
          closed = true;
          server.closeAllConnections();
          await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
          conversations.close();
        },
      };
      running.push(item);
      return item;
    },
  };
}
async function run(base, id, content = '你好') {
  const conversationId = (await (await fetch(base + '/api/conversations')).json()).defaultConversationId;
  return fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId, submissionId: id, input: { messages: [{ role: 'user', content }] } }) });
}
const frames = async (response) => submissionSnapshots((await response.text()).trim().split('\n').map(JSON.parse));
const get = async (base, path) => {
  const catalog = await (await fetch(base + '/api/conversations')).json();
  const current = catalog.conversations.find((item) => item.id === catalog.defaultConversationId);
  const url = new URL(path, base);
  if (url.pathname === '/api/transcript') url.searchParams.set('id', current.transcriptId);
  else url.searchParams.set('conversationId', current.id);
  return (await fetch(url)).json();
};

test('HTTP restart restores content and record details but cannot claim the old submission is resumable', async (t) => {
  const disk = fixture(t);
  const first = await disk.start();
  assert.equal((await frames(await run(first.base, 'old-submission'))).at(-1).result.status, 'completed');
  const before = await get(first.base, '/api/transcript');
  const previous = await get(first.base, '/api/executions');
  await first.close();
  const next = await disk.start();
  assert.deepEqual(await get(next.base, '/api/transcript'), before);
  assert.equal(next.calls, 0);
  assert.equal((await get(next.base, '/api/conversation/admission')).status, 'ready');
  const unknown = await fetch(next.base + '/api/submissions/old-submission');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'SUBMISSION_UNAVAILABLE');
  const detail = await get(next.base, '/api/execution?id=' + previous.executions[0].id);
  assert.equal(detail.archive.state, 'sealed');
  validateExecutionRecordSnapshot(detail);
  assert.equal((await frames(await run(next.base, 'new-submission', '下一轮'))).at(-1).result.status, 'completed');
  assert.equal((await get(next.base, '/api/transcript')).messages.length, 4);
});

test('content save failure gates following submissions through server admission without calling the model', async (t) => {
  const disk = fixture(t);
  SqliteObserverStore.open(disk.path).close();
  const db = new DatabaseSync(disk.path);
  db.exec("CREATE TRIGGER reject_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  db.close();
  const current = await disk.start();
  const first = await run(current.base, 'failed-save');
  await first.text();
  assert.equal((await get(current.base, '/api/conversation/admission')).status, 'unavailable');
  assert.equal((await get(current.base, '/api/transcript')).messages.length, 0);
  const next = await run(current.base, 'must-not-run');
  assert.equal(next.status, 503);
  const baseline = await next.json();
  assert.equal(baseline.type, 'baseline');
  const refusal = baseline.submission;
  assert.equal(refusal.result.status, 'rejected');
  assert.equal(refusal.result.error.code, 'PERSISTENCE_UNAVAILABLE');
  assert.equal(current.calls, 0);
});

test('unreadable historical records fail observation explicitly while transcript delivery and new QA remain available', async (t) => {
  const disk = fixture(t);
  const first = await disk.start();
  assert.equal((await frames(await run(first.base, 'before-damage'))).at(-1).result.status, 'completed');
  const original = await get(first.base, '/api/transcript');
  await first.close();
  const database = new DatabaseSync(disk.path);
  database.exec("UPDATE records SET body = json_set(body, '$.id', 'invalid-record-id') WHERE kind = 'execution'");
  database.close();
  const next = await disk.start();
  assert.deepEqual(await get(next.base, '/api/transcript'), original);
  assert.equal((await get(next.base, '/api/conversation/admission')).status, 'ready');
  const overview = await get(next.base, '/api/executions');
  assert.equal(overview.code, 'SOURCE_INCOMPLETE');
  const feed = await get(next.base, '/api/observe');
  assert.equal(feed.code, 'SOURCE_INCOMPLETE');
  assert.equal((await frames(await run(next.base, 'after-damage'))).at(-1).result.status, 'completed');
  assert.equal((await get(next.base, '/api/transcript')).messages.length, 4);
  assert.equal((await get(next.base, '/api/conversation/admission')).status, 'ready');
});
