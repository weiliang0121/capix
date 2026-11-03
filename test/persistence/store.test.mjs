import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PersistenceError } from '@capix/diagnostics';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { SqliteObserverStore, initializeObserver, observeOverview } from '@capix/observer-service';
import { validateExecutionRecordSnapshot } from '@capix/protocol';
import { CallableRecord, CallableRecordHelper } from '@capix/records';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const provider = {
  async invoke(_request, purpose) {
    return { id: 'fixture', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: '保存的回答' } : { memories: [] }), finishReason: 'stop', usage: null };
  },
};

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-persistence-'));
  const path = join(directory, 'observer.sqlite');
  const stores = [];
  const environments = [];
  t.after(() => {
    for (const environment of environments) environment.close();
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    track(environment) {
      environments.push(environment);
    },
    open() {
      const store = SqliteObserverStore.open(path);
      stores.push(store);
      return store;
    },
  };
}
function createContent(store) {
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  store.initialize({ transcript: transcript.exportState(), memories: memories.exportState() });
  const restoredTranscript = Transcript.restore(transcript.exportState(), { persistence: store.transcript });
  return { transcript: restoredTranscript, memories: Memories.restore(memories.exportState(), restoredTranscript, { persistence: store.memories }) };
}
function createMemory(topic, indexes = [0, 1]) {
  return { action: 'create', memoryId: null, change: '记录有效事实', sourceIndexes: indexes, result: { topic, content: '已接受的信息', sourceIndexes: indexes } };
}
function installTrigger(path, sql) {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

test('content roundtrip preserves identities, segmentation, memory source receipts and update order without recording', (t) => {
  const disk = fixture(t);
  const store = disk.open();
  const content = createContent(store);
  content.transcript.append({ role: 'user', content: '写文件' }, { role: 'assistant', content: '正文' });
  content.transcript.append({ role: 'user', content: '继续' });
  content.transcript.startSegment(2);
  const source = { id: 'receipt-1', kind: 'file-created', answerIndex: 1, receipt: { path: 'saved.md', bytes: 6, digest: 'a'.repeat(64) } };
  const change = createMemory('文件');
  change.sourceResults = [source];
  change.result.sourceResults = [source];
  const [first, second] = content.memories.apply([change, createMemory('第二条')]);
  content.memories.apply([{ action: 'update', memoryId: first.id, change: '补充', sourceIndexes: [2], result: { ...first.snapshot(), content: '更新的事实', sourceIndexes: [0, 1, 2] } }]);
  const expected = { transcript: content.transcript.exportState(), memories: content.memories.exportState() };
  store.close();
  const reopened = disk.open();
  const saved = reopened.loadContent();
  assert.deepEqual(saved.transcript, expected.transcript);
  assert.deepEqual(saved.memories, expected.memories);
  assert.deepEqual(
    saved.memories.items.map((item) => item.id),
    [first.id, second.id],
  );
  const transcript = Transcript.restore(saved.transcript, { persistence: reopened.transcript });
  const memories = Memories.restore(saved.memories, transcript, { persistence: reopened.memories });
  transcript.append({ role: 'assistant', content: '重启后回答' });
  assert.equal(transcript.get(3).content, '重启后回答');
  assert.equal(transcript.revision, expected.transcript.revision + 1);
  assert.equal(memories.get(first.id).sourceResults[0].receipt.path, 'saved.md');
  assert.deepEqual(reopened.loadRecording().book.entries, []);
});

test('SQL failure rolls back the entire append and memory batch before in-memory visibility', (t) => {
  const disk = fixture(t);
  disk.open().close();
  installTrigger(
    disk.path,
    `
    CREATE TRIGGER reject_message BEFORE INSERT ON messages WHEN json_extract(NEW.body, '$.content') = 'reject'
    BEGIN SELECT RAISE(ABORT, 'fixture'); END;
    CREATE TRIGGER reject_memory BEFORE INSERT ON memories WHEN json_extract(NEW.body, '$.topic') = 'reject'
    BEGIN SELECT RAISE(ABORT, 'fixture'); END;
  `,
  );
  const store = disk.open();
  const content = createContent(store);
  assert.throws(
    () => content.transcript.append({ role: 'user', content: 'first' }, { role: 'assistant', content: 'reject' }),
    (error) => error instanceof PersistenceError && error.operation === 'transcript.commit' && error.cause.code === 'PERSISTENCE_UNAVAILABLE' && /保存或加载失败/.test(error.cause.message),
  );
  assert.equal(content.transcript.length, 0);
  assert.equal(store.loadContent().transcript.messages.length, 0);
  assert.equal(store.failure.code, 'PERSISTENCE_UNAVAILABLE');
  assert.throws(
    () => content.transcript.append({ role: 'user', content: 'still blocked' }),
    (error) => error instanceof PersistenceError && error.operation === 'transcript.commit' && error.cause.code === 'PERSISTENCE_UNAVAILABLE' && /内容存储不可用/.test(error.cause.message),
  );
  store.close();
  const reopened = disk.open();
  const saved = reopened.loadContent();
  const transcript = Transcript.restore(saved.transcript, { persistence: reopened.transcript });
  const memories = Memories.restore(saved.memories, transcript, { persistence: reopened.memories });
  transcript.append({ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer' });
  assert.throws(
    () => memories.apply([createMemory('first'), createMemory('reject')]),
    (error) => error instanceof PersistenceError && error.operation === 'memories.commit' && error.cause.code === 'PERSISTENCE_UNAVAILABLE' && /保存或加载失败/.test(error.cause.message),
  );
  assert.equal(memories.values().length, 0);
  assert.equal(memories.sequence, 0);
  assert.equal(reopened.loadContent().memories.items.length, 0);
  assert.equal(reopened.loadContent().transcript.messages.length, 2, 'previously committed answer survives');
});

test('second writer is excluded, unknown schema and broken metadata cannot become an empty conversation', (t) => {
  const disk = fixture(t);
  const store = disk.open();
  assert.throws(() => disk.open(), /locked/);
  store.close();
  installTrigger(disk.path, 'PRAGMA user_version = 99');
  assert.throws(() => disk.open(), /Unsupported/);
  installTrigger(disk.path, "PRAGMA user_version = 5; INSERT INTO transcripts VALUES ('orphan', 0, '[0]')");
  const broken = disk.open();
  assert.throws(() => broken.loadContent(), /保存或加载失败/);
});

test('restored environment continues a new QA while retaining original queryable record trees', async (t) => {
  const disk = fixture(t);
  const first = initializeObserver(provider, [], { persistence: disk.open() });
  await first.runner.run({ messages: [{ role: 'user', content: '你好' }] }, { settings });
  const expected = first.records.book.exportState();
  const oldRoot = first.records.installation.root.id;
  const oldTranscript = first.transcript.id;
  const execution = first.records.book.values().find((record) => record instanceof CallableRecord && record.role === 'conversation-task');
  first.close();
  const restored = initializeObserver(provider, [], { persistence: disk.open() });
  disk.track(restored);
  assert.equal(restored.transcript.id, oldTranscript);
  assert.notEqual(restored.records.installation.root.id, oldRoot);
  assert.equal(restored.records.archives[0].state, 'sealed');
  for (const entry of expected.entries) assert.deepEqual(restored.records.book.get(entry.data.id).toJSON(), entry.data);
  const snapshot = CallableRecordHelper.snapshot(restored.records.recorder, execution.id);
  validateExecutionRecordSnapshot(snapshot);
  assert.equal(snapshot.execution.status, 'succeeded');
  await restored.runner.run({ messages: [{ role: 'user', content: '下一轮' }] }, { settings });
  assert.equal(restored.transcript.length, 4);
  const overview = observeOverview(restored);
  assert.equal(overview.executions.length, 2);
  assert.equal(overview.executions[0].archive.state, 'sealed');
  assert.equal(overview.executions[1].archive, undefined);
  assert.ok(restored.records.recorder.tree.children(oldRoot).every((record) => record.historical));
});

test('optional record saving failure preserves content and saves an honest incomplete archive prefix', async (t) => {
  const disk = fixture(t);
  disk.open().close();
  installTrigger(disk.path, "CREATE TRIGGER reject_operation BEFORE INSERT ON records WHEN NEW.kind = 'invocation' AND json_extract(NEW.body, '$.structureKind') = 'group' BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  const store = disk.open();
  const first = initializeObserver(provider, [], { persistence: store });
  await first.runner.run({ messages: [{ role: 'user', content: '你好' }] }, { settings });
  assert.equal(first.transcript.length, 2);
  assert.equal(store.failure, undefined, 'record constraint failure is not a content failure');
  assert.throws(() => first.records.source.assertComplete(), /不完整/);
  first.close();
  const reopened = disk.open();
  const state = reopened.loadRecording();
  assert.equal(state.archives[0].state, 'incomplete');
  const restored = initializeObserver(provider, [], { persistence: reopened });
  disk.track(restored);
  assert.equal(restored.transcript.length, 2);
  assert.equal(restored.records.archives[0].state, 'incomplete');
  assert.doesNotThrow(() => restored.records.source.assertComplete(), 'new source may be healthy without concealing archive gap');
});
