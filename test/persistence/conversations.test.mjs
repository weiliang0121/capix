import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ObserverConversations, SqliteObserverStore, observeOverview } from '@capix/observer-service';
import { TranscriptRecord, MemoryRecord } from '@weiliang0121/capix-records';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
const provider = {
  async invoke(_request, purpose) {
    return { id: 'fixture', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: '已完成' } : { memories: [] }), finishReason: 'stop', usage: null };
  },
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-conversations-'));
  const path = join(directory, 'observer.sqlite');
  const hosts = [];
  t.after(() => {
    for (const host of hosts) host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open() {
      const host = new ObserverConversations(provider, [], { persistence: SqliteObserverStore.open(path) });
      hosts.push(host);
      return host;
    },
  };
}
function remember(content, label) {
  return content.memories.apply([{ action: 'create', memoryId: null, change: label, sourceIndexes: [0, 1], result: { topic: label, content: label, sourceIndexes: [0, 1] } }])[0];
}

test('two persisted conversations retain separate messages, memories, records and future work across restart', async (t) => {
  const disk = fixture(t);
  const host = disk.open();
  const first = host.list().defaultConversationId;
  const second = host.create().id;
  const left = host.open(first);
  const right = host.open(second);
  await left.runner.run({ messages: [{ role: 'user', content: '第一段主题' }] }, { settings });
  await right.runner.run({ messages: [{ role: 'user', content: '第二段主题' }] }, { settings });
  const leftMemory = remember(left, '第一段记忆');
  const rightMemory = remember(right, '第二段记忆');
  const leftRecords = left.records.book.exportState();
  const rightRecords = right.records.book.exportState();
  assert.ok(left.records.book.values().some((record) => record instanceof TranscriptRecord));
  assert.ok(
    left.records.book.values().some((record) => record instanceof MemoryRecord && record.memoryId === leftMemory.id),
    'content direct changes keep the installed recording fallback',
  );
  assert.ok(right.records.book.values().some((record) => record instanceof MemoryRecord && record.memoryId === rightMemory.id));
  const leftId = left.transcript.id;
  const rightId = right.transcript.id;
  assert.notEqual(leftId, rightId);
  host.close();

  const reopened = disk.open();
  assert.equal(reopened.list().defaultConversationId, first);
  assert.equal(reopened.list().conversations.length, 2);
  assert.equal(reopened.get(first).title, '第一段主题');
  assert.equal(reopened.get(second).title, '第二段主题');
  const restoredLeft = reopened.open(first);
  const restoredRight = reopened.open(second);
  assert.equal(restoredLeft.transcript.id, leftId);
  assert.equal(restoredRight.transcript.id, rightId);
  assert.equal(restoredLeft.memories.values()[0].id, leftMemory.id);
  assert.equal(restoredRight.memories.values()[0].id, rightMemory.id);
  assert.equal(restoredRight.memories.get(leftMemory.id), undefined);
  for (const entry of leftRecords.entries) assert.deepEqual(restoredLeft.records.book.get(entry.data.id).toJSON(), entry.data);
  for (const entry of rightRecords.entries) assert.equal(restoredLeft.records.book.get(entry.data.id), undefined);
  assert.equal(observeOverview(restoredLeft).executions.length, 1);
  assert.equal(observeOverview(restoredRight).executions.length, 1);
  await restoredRight.runner.run({ messages: [{ role: 'user', content: '只继续第二段' }] }, { settings });
  assert.equal(restoredRight.transcript.length, 4);
  assert.equal(restoredLeft.transcript.length, 2);
  restoredLeft.close();
  assert.equal(reopened.persistence.failure, undefined, 'closing a single environment never closes the shared database');
  assert.equal(reopened.get(second).transcriptId, rightId);
});

test('new conversation metadata and empty entity identities are installed in one required transaction', (t) => {
  const disk = fixture(t);
  const initial = disk.open();
  const id = initial.list().defaultConversationId;
  initial.close();
  const database = new DatabaseSync(disk.path);
  database.exec("CREATE TRIGGER reject_conversation BEFORE INSERT ON conversations BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  database.close();
  const host = disk.open();
  assert.throws(() => host.create(), /保存或加载失败/);
  assert.equal(host.persistence.failure.code, 'PERSISTENCE_UNAVAILABLE');
  host.close();
  const check = new DatabaseSync(disk.path);
  try {
    assert.equal(check.prepare('SELECT count(*) AS count FROM conversations').get().count, 1);
    assert.equal(check.prepare('SELECT count(*) AS count FROM transcripts').get().count, 1);
    assert.equal(check.prepare('SELECT count(*) AS count FROM memory_sets').get().count, 1);
    assert.equal(check.prepare('SELECT default_id FROM conversation_settings').get().default_id, id);
  } finally {
    check.close();
  }
});

test('v2 single-conversation content is refused without changing its identities or records', async (t) => {
  const disk = fixture(t);
  const host = disk.open();
  const id = host.list().defaultConversationId;
  const environment = host.open(id);
  await environment.runner.run({ messages: [{ role: 'user', content: '原有对话' }] }, { settings });
  host.close();
  const database = new DatabaseSync(disk.path);
  database.exec(`PRAGMA user_version = 2;`);
  const before = {
    conversations: database.prepare('SELECT * FROM conversations').all(),
    transcripts: database.prepare('SELECT * FROM transcripts').all(),
    messages: database.prepare('SELECT * FROM messages').all(),
    records: database.prepare('SELECT * FROM records').all(),
    schema: database.prepare('SELECT * FROM sqlite_master ORDER BY name').all(),
  };
  database.close();
  assert.throws(() => disk.open(), /Unsupported Observer persistence schema/);
  const after = new DatabaseSync(disk.path);
  try {
    assert.equal(after.prepare('PRAGMA user_version').get().user_version, 2);
    for (const table of ['conversations', 'transcripts', 'messages', 'records']) assert.deepEqual(after.prepare(`SELECT * FROM ${table}`).all(), before[table]);
    assert.deepEqual(after.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), before.schema);
  } finally {
    after.close();
  }
});
