import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ObserverConversations, SqliteObserverStore, observeOverview } from '@capix/observer-service';
import { TranscriptRecord, MemoryRecord } from '@capix/records';

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

test('v2 single-conversation migration preserves identities, indexes, source ownership and chooses one default', async (t) => {
  const disk = fixture(t);
  const host = disk.open();
  const id = host.list().defaultConversationId;
  const environment = host.open(id);
  await environment.runner.run({ messages: [{ role: 'user', content: ' \n '.repeat(40) + '原有对话' }] }, { settings });
  const saved = host.persistence.loadContent(id);
  delete saved.transcript.appends;
  delete saved.memories.applies;
  const recording = host.persistence.loadRecording(id);
  host.close();
  const database = new DatabaseSync(disk.path);
  database.exec(`CREATE TABLE metadata(singleton INTEGER PRIMARY KEY, transcript_id TEXT, memories_id TEXT); INSERT INTO metadata SELECT 1, transcript_id, memories_id FROM conversations; DROP TABLE conversation_settings; ALTER TABLE record_sources DROP COLUMN conversation_id; DROP TABLE conversation_checkpoint_runs; DROP TABLE checkpoint_heads; DROP TABLE checkpoint_images; DROP TABLE conversations; DROP TABLE transcript_appends; DROP TABLE memory_applies; DROP TABLE file_creations; PRAGMA user_version = 2;`);
  database.close();
  const migrated = disk.open();
  const current = migrated.list();
  assert.equal(current.conversations.length, 1);
  assert.equal(current.conversations[0].transcriptId, saved.transcript.id);
  assert.equal(current.conversations[0].title, '原有对话');
  assert.deepEqual(migrated.persistence.loadContent(current.defaultConversationId), saved);
  assert.deepEqual(migrated.persistence.loadRecording(current.defaultConversationId), { ...recording, archives: recording.archives.map((archive) => ({ ...archive, state: 'sealed' })) });
  const created = migrated.create();
  assert.equal(migrated.list().conversations.length, 2);
  assert.notEqual(created.id, current.defaultConversationId);
  assert.equal(migrated.content(created.id).transcript.length, 0);
});
