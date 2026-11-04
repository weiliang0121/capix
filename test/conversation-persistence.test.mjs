import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent, restoreConversationContent } from '@capix/conversation-service/assembly';
import { TranscriptViewSource } from '@capix/transcript';
import { MemoryViewSource } from '@capix/memory';
import { PersistenceError } from '@capix/diagnostics';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-conversation-store-'));
  const path = join(directory, 'content.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    path,
    open() {
      const store = ConversationStore.open(path);
      stores.push(store);
      return store;
    },
  };
}

function snapshot(content) {
  return { transcript: content.transcript.exportState(), memories: content.memories.exportState(), view: content.view.exportState() };
}

function sources(content) {
  return { messages: new TranscriptViewSource(content.transcript), memories: new MemoryViewSource(content.memories) };
}

function createChange(text, indexes = [0]) {
  return { action: 'create', memoryId: null, change: '记住用户的偏好', sourceIndexes: indexes, result: { topic: '偏好', content: text, sourceIndexes: indexes } };
}

test('conversation store reopens the exact message, memory, segment and View state without re-including excluded content', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  content.transcript.append({ role: 'user', content: '喜欢清淡' }, { role: 'assistant', content: '记住了' });
  content.transcript.startSegment(1);
  const [memory] = content.memories.apply([createChange('喜欢清淡')]);
  content.view.includeSync(
    sources(content),
    [
      { source: 'messages', key: 0 },
      { source: 'messages', key: 1 },
      { source: 'memories', key: memory.id },
    ],
    store.view,
  );
  content.view.excludeSync([{ source: 'messages', key: 0 }], store.view);
  const expected = snapshot(content);
  assert.deepEqual(store.load(), expected);
  assert.equal(statSync(files.path).mode & 0o777, 0o600);
  store.close();

  const reopened = files.open();
  const restored = loadConversationContent(reopened);
  assert.deepEqual(snapshot(restored), expected);
  assert.equal(restored.view.has({ source: 'messages', key: 0 }), false);
  restored.transcript.append({ role: 'user', content: '下一次输入' });
  assert.equal(reopened.load().transcript.messages.length, 3);
  assert.equal(restored.view.has({ source: 'messages', key: 2 }), false, 'entity append does not implicitly change View membership');
});

test('memory update preserves insertion order and fixed effect receipts survive close/reopen, including an empty apply', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  const append = { contract: { key: 'transcript.append', version: 1 }, operation: { parentContextId: 'p', childContextId: 'c', position: 'answer' }, transcriptId: content.transcript.id, messages: [{ role: 'user', content: '偏好清淡' }] };
  const appendReceipt = content.transcript.applyFixed(append);
  const apply = { contract: { key: 'memories.apply', version: 1 }, operation: { contextId: 'apply-call', position: 'memory' }, memoriesId: content.memories.id, changes: [createChange('喜欢清淡'), createChange('喜欢汤')] };
  const applyReceipt = content.memories.applyFixed(apply);
  const firstId = applyReceipt.memoryIds[0];
  content.memories.apply([{ ...createChange('改为少盐'), action: 'update', memoryId: firstId }]);
  const empty = { ...apply, operation: { contextId: 'no-op-call', position: 'memory' }, changes: [] };
  const emptyReceipt = content.memories.applyFixed(empty);
  const expected = snapshot(content);
  store.close();

  const reopened = files.open();
  const restored = loadConversationContent(reopened);
  assert.deepEqual(snapshot(restored), expected);
  assert.deepEqual(
    restored.memories.values().map((memory) => memory.id),
    applyReceipt.memoryIds,
  );
  assert.equal(restored.memories.get(firstId).content, '改为少盐');
  assert.deepEqual(restored.transcript.applyFixed(append), appendReceipt);
  assert.deepEqual(restored.memories.applyFixed(apply), applyReceipt);
  assert.deepEqual(restored.memories.applyFixed(empty), emptyReceipt);
  assert.deepEqual(reopened.load(), expected, 'replaying a fixed receipt must not write again');
});

test('stale transcript writer is rejected before installing memory state, and the uncertain store stops admission', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  const stale = restoreConversationContent(snapshot(content), store);
  content.transcript.append({ role: 'user', content: 'first' });
  assert.throws(() => stale.transcript.append({ role: 'user', content: 'stale' }), PersistenceError);
  assert.equal(stale.transcript.length, 0);
  assert.throws(() => store.assertAvailable(), PersistenceError);
  store.close();
  assert.deepEqual(files.open().load().transcript.messages, [{ role: 'user', content: 'first' }]);
});

test('stale memory writer cannot overwrite a committed batch', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  content.transcript.append({ role: 'user', content: 'first' });
  const stale = restoreConversationContent(snapshot(content), store);
  content.memories.apply([createChange('fresh')]);
  assert.throws(() => stale.memories.apply([createChange('stale')]), PersistenceError);
  assert.equal(stale.memories.values().length, 0);
  store.close();
  assert.equal(files.open().load().memories.items[0].content, 'fresh');
});

test('View commit verifies only the supplied source stamps and rejects a stale source before installation', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  content.transcript.append({ role: 'user', content: 'first' });
  const stale = restoreConversationContent(snapshot(content), store);
  content.transcript.append({ role: 'assistant', content: 'second' });
  assert.throws(() => stale.view.includeSync(sources(stale), [{ source: 'messages', key: 0 }], store.view), PersistenceError);
  assert.equal(stale.view.members().length, 0);
  store.close();
  const saved = files.open().load();
  assert.equal(saved.transcript.messages.length, 2, 'message commit remains true when later membership commit fails');
  assert.equal(saved.view.members.length, 0);
});

test('View removal needs no source stamps, while stale membership revisions cannot replace current members', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  content.transcript.append({ role: 'user', content: 'first' });
  content.view.includeSync(sources(content), [{ source: 'messages', key: 0 }], store.view);
  const stale = restoreConversationContent(snapshot(content), store);
  content.transcript.append({ role: 'assistant', content: 'second' });
  stale.view.excludeSync([{ source: 'messages', key: 0 }], store.view);
  assert.deepEqual(store.load().view.members, []);
  assert.throws(() => content.view.excludeSync([{ source: 'messages', key: 0 }], store.view), PersistenceError);
  assert.equal(content.view.members().length, 1);
});

test('a closed persistence port cannot install an append in a still-live entity', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  store.close();
  assert.throws(() => content.transcript.append({ role: 'user', content: 'lost' }), PersistenceError);
  assert.equal(content.transcript.length, 0);
  assert.equal(files.open().load().transcript.messages.length, 0);
});

test('a database error halfway through a message batch rolls back rows and metadata and stops admission', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  initial.close();
  const fault = new DatabaseSync(files.path);
  fault.exec("CREATE TRIGGER reject_second_message BEFORE INSERT ON messages WHEN NEW.position = 1 BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;");
  fault.close();
  const store = files.open();
  const content = loadConversationContent(store);
  assert.throws(() => content.transcript.append({ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' }), PersistenceError);
  assert.equal(content.transcript.length, 0);
  assert.throws(() => store.assertAvailable(), PersistenceError);
  store.close();
  const saved = files.open().load();
  assert.equal(saved.transcript.revision, 0);
  assert.deepEqual(saved.transcript.messages, []);
});

test('a database error halfway through memory application rolls back the entire batch', (t) => {
  const files = fixture(t);
  const initial = files.open();
  const initialContent = loadConversationContent(initial);
  initialContent.transcript.append({ role: 'user', content: 'preferences' });
  initial.close();
  const fault = new DatabaseSync(files.path);
  fault.exec("CREATE TRIGGER reject_memory BEFORE INSERT ON memories WHEN json_extract(NEW.body, '$.content') = 'blocked' BEGIN SELECT RAISE(ABORT, 'simulated memory failure'); END;");
  fault.close();
  const store = files.open();
  const content = loadConversationContent(store);
  assert.throws(() => content.memories.apply([createChange('first'), createChange('blocked')]), PersistenceError);
  assert.equal(content.memories.sequence, 0);
  assert.equal(content.memories.values().length, 0);
  store.close();
  const saved = files.open().load();
  assert.equal(saved.memories.sequence, 0);
  assert.deepEqual(saved.memories.items, []);
  assert.equal(saved.transcript.messages.length, 1);
});

test('SQLite lock excludes a second host and releases on close', (t) => {
  const files = fixture(t);
  const store = files.open();
  loadConversationContent(store);
  assert.throws(() => ConversationStore.open(files.path), PersistenceError);
  store.assertAvailable();
  store.close();
  assert.ok(files.open().load());
});

test('unknown databases and newer versions are rejected without reinitializing them', (t) => {
  const files = fixture(t);
  const other = new DatabaseSync(files.path);
  other.exec("CREATE TABLE secret(value TEXT); INSERT INTO secret VALUES ('preserve');");
  other.close();
  const before = readFileSync(files.path);
  assert.throws(() => ConversationStore.open(files.path), PersistenceError);
  assert.deepEqual(readFileSync(files.path), before);
  rmSync(files.path);
  const store = files.open();
  loadConversationContent(store);
  store.close();
  const newer = new DatabaseSync(files.path);
  newer.exec('PRAGMA user_version = 3');
  newer.close();
  assert.throws(() => ConversationStore.open(files.path), PersistenceError);
});

test('a foreign database containing only a SQL view is not an empty conversation database', (t) => {
  const files = fixture(t);
  const other = new DatabaseSync(files.path);
  other.exec("CREATE VIEW external_view AS SELECT 'preserve' AS value;");
  const journal = other.prepare('PRAGMA journal_mode').get();
  const schema = other.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all();
  other.close();
  const before = readFileSync(files.path);
  assert.throws(() => ConversationStore.open(files.path), PersistenceError);
  assert.deepEqual(readFileSync(files.path), before);
  const unchanged = new DatabaseSync(files.path);
  try {
    assert.deepEqual(unchanged.prepare('PRAGMA journal_mode').get(), journal);
    assert.deepEqual(unchanged.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY name').all(), schema);
    assert.equal(unchanged.prepare('PRAGMA application_id').get().application_id, 0);
    assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 0);
  } finally {
    unchanged.close();
  }
});

test('missing message rows or invalid View references are content errors, never an empty-conversation fallback', (t) => {
  for (const corruption of ['gap', 'view']) {
    const files = fixture(t);
    const store = files.open();
    const content = loadConversationContent(store);
    content.transcript.append({ role: 'user', content: 'first' }, { role: 'assistant', content: 'second' });
    store.close();
    const corrupt = new DatabaseSync(files.path);
    if (corruption === 'gap') corrupt.exec('DELETE FROM messages WHERE position = 0');
    else corrupt.prepare('UPDATE content SET view_state = ?').run(JSON.stringify({ ...content.view.exportState(), members: [{ source: 'messages', key: 99 }] }));
    corrupt.close();
    const reopened = files.open();
    assert.throws(() => loadConversationContent(reopened), PersistenceError);
    assert.throws(() => reopened.assertAvailable(), PersistenceError);
  }
});

test('uninitialized schema is safe to initialize once; orphan rows and non-SQLite files are rejected', (t) => {
  const files = fixture(t);
  const store = files.open();
  assert.equal(store.load(), undefined);
  store.close();
  const orphan = new DatabaseSync(files.path);
  orphan.prepare('INSERT INTO messages VALUES (0, ?)').run(JSON.stringify({ role: 'user', content: 'orphan' }));
  orphan.close();
  assert.throws(() => files.open().load(), PersistenceError);
  const invalid = join(files.directory, 'not-sqlite');
  writeFileSync(invalid, 'not a database');
  assert.throws(() => ConversationStore.open(invalid), PersistenceError);
  assert.equal(readFileSync(invalid, 'utf8'), 'not a database');
});
