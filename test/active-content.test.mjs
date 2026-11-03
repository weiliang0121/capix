import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PersistenceError } from '@capix/diagnostics';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { ActiveView, ConversationContent } from '@capix/observer-content';
import { SqliteObserverStore } from '@capix/observer-service/assembly';

const message = (content) => ({ role: 'user', content });
const createMemory = (content) => ({ action: 'create', memoryId: null, change: '记忆建立', sourceIndexes: [0], result: { topic: '偏好', content, sourceIndexes: [0] } });
const updateMemory = (id, content) => ({ ...createMemory(content), action: 'update', memoryId: id });
const indexes = (snapshot) => snapshot.messages.map((item) => item.index);

test('active view keeps its saved format and only commits explicit changed membership', () => {
  const transcript = new Transcript([message('source')]);
  const memories = new Memories(transcript);
  const [first] = memories.apply([createMemory('first')]);
  const commits = [];
  const active = new ActiveView(transcript, memories, {
    persistence: {
      commit(change) {
        assert.equal(active.exportState().revision + 1, change.state.revision, 'persistence runs before installing the selection');
        commits.push(change);
      },
    },
  });
  const initial = active.capture();
  assert.equal(initial.messages[0].message, transcript.get(0), 'immutable formal messages retain their exact identity');
  const selected = active.apply({ basis: initial.basis, messageIndexes: [], memoryIds: [first.id] });
  assert.deepEqual(commits, [{ basis: initial.basis, state: { transcriptId: transcript.id, memoriesId: memories.id, revision: 1, messageIndexes: [], memoryIds: [first.id] } }]);
  transcript.append(message('new message'));
  const [second] = memories.apply([createMemory('second')]);
  const current = active.capture();
  assert.deepEqual(indexes(current), [1]);
  assert.deepEqual(
    current.memories.map((item) => item.id),
    [first.id, second.id],
  );
  assert.equal(current.basis.indexRevision, selected.basis.indexRevision + 1, 'one synchronization installs both newly discovered sources');
  assert.equal(commits.length, 1, 'automatic inclusion belongs to source persistence, not explicit view persistence');
  const unchanged = active.apply({ basis: current.basis, messageIndexes: [1], memoryIds: [first.id, second.id] });
  assert.deepEqual(unchanged, current);
  assert.equal(commits.length, 1, 'source grouping cannot turn an equal selection into a new write');
  const restored = new ActiveView(transcript, memories, { saved: active.exportState() });
  assert.deepEqual(restored.capture(), current);
  assert.deepEqual(Object.keys(active.exportState()), ['transcriptId', 'memoriesId', 'revision', 'messageIndexes', 'memoryIds']);
});

test('active view rejects asynchronous persistence without installing changed membership', async () => {
  const transcript = new Transcript([message('source')]);
  const memories = new Memories(transcript);
  const active = new ActiveView(transcript, memories, { persistence: { commit: () => Promise.reject(new Error('late persistence rejection')) } });
  const before = active.capture();
  assert.throws(() => active.apply({ basis: before.basis, messageIndexes: [], memoryIds: [] }), /synchronously/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(active.capture(), before);
});

test('active membership permits noncontiguous filtering, preserves explicit order and adds only newly created content', (t) => {
  const content = new ConversationContent({ messages: [message('zero'), message('one'), message('two')] });
  t.after(() => content.close());
  const [first, second] = content.memories.apply([createMemory('first'), createMemory('second')]);
  const before = content.active.capture();
  const selected = content.active.apply({ basis: before.basis, messageIndexes: [2, 0], memoryIds: [second.id] });
  assert.deepEqual(indexes(selected), [2, 0]);
  assert.deepEqual(
    selected.memories.map((item) => item.id),
    [second.id],
  );
  assert.equal(content.transcript.length, 3, 'filtering never deletes original content');
  assert.equal(content.memories.values().length, 2);
  content.transcript.append(message('three'));
  content.memories.apply([updateMemory(first.id, 'excluded update')]);
  const [third] = content.memories.apply([createMemory('third')]);
  const current = content.active.capture();
  assert.deepEqual(indexes(current), [2, 0, 3]);
  assert.deepEqual(
    current.memories.map((item) => item.id),
    [second.id, third.id],
  );
  assert.equal(current.basis.indexRevision, selected.basis.indexRevision + 2, 'only membership changes advance the index');
  assert.equal(before.messages.length, 3, 'fixed snapshots do not expand after source append');
  assert.equal(before.memories[0].content, 'first', 'fixed snapshots do not follow memory updates');
  assert.ok(Object.isFrozen(current) && Object.isFrozen(current.messages) && Object.isFrozen(current.messages[0]) && Object.isFrozen(current.memories[0]));
});

test('active decisions reject changed source values and invalid members, while equal decisions leave the revision unchanged', (t) => {
  const content = new ConversationContent({ messages: [message('source')] });
  t.after(() => content.close());
  const [memory] = content.memories.apply([createMemory('before')]);
  const before = content.active.capture();
  const same = content.active.apply({ basis: before.basis, messageIndexes: [0], memoryIds: [memory.id] });
  assert.deepEqual(same.basis, before.basis);
  content.memories.apply([updateMemory(memory.id, 'after')]);
  const current = content.active.capture();
  assert.equal(current.basis.indexRevision, before.basis.indexRevision);
  assert.notEqual(current.basis.memorySequence, before.basis.memorySequence);
  assert.equal(current.memories[0].content, 'after');
  assert.throws(
    () => content.active.apply({ basis: before.basis, messageIndexes: [], memoryIds: [] }),
    (error) => error.code === 'ACTIVE_CONTENT_CONFLICT',
  );
  assert.throws(() => content.active.apply({ basis: current.basis, messageIndexes: [0, 0], memoryIds: [] }), /unique/);
  assert.throws(() => content.active.apply({ basis: current.basis, messageIndexes: [4], memoryIds: [] }), /does not exist/);
  assert.throws(() => content.active.apply({ basis: current.basis, messageIndexes: [], memoryIds: ['foreign'] }), /does not exist/);
  assert.deepEqual(content.active.capture(), current);
});

test('required active indexing is independent of optional observation and catches direct entity writes', (t) => {
  const content = new ConversationContent();
  t.after(() => content.close());
  content.observe({
    transcript: {
      publish() {
        throw new Error('observer failed');
      },
    },
    memory: {
      publish() {
        throw new Error('observer failed');
      },
    },
  });
  assert.throws(() => content.transcript.append(message('committed')), /observer failed/);
  assert.deepEqual(indexes(content.active.capture()), [0]);
  assert.throws(() => content.memories.apply([createMemory('committed')]), /observer failed/);
  assert.equal(content.active.capture().memories[0].content, 'committed');
});

function diskFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-active-'));
  const path = join(directory, 'observer.sqlite');
  const stores = [];
  const contents = [];
  t.after(() => {
    for (const content of contents) content.close();
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open() {
      const store = SqliteObserverStore.open(path);
      stores.push(store);
      return store;
    },
    content(store) {
      const content = new ConversationContent({ saved: store.loadContent(), persistence: store });
      contents.push(content);
      return content;
    },
    initialize(store, transcript = new Transcript()) {
      const memories = new Memories(transcript);
      store.initialize({ transcript: transcript.exportState(), memories: memories.exportState() });
    },
    edit(sql) {
      const database = new DatabaseSync(path);
      try {
        database.exec(sql);
      } finally {
        database.close();
      }
    },
  };
}

test('active index and filtered membership survive reopening; source appends and new memories remain synchronized', (t) => {
  const disk = diskFixture(t);
  const store = disk.open();
  disk.initialize(store, new Transcript([message('zero'), message('one'), message('two')]));
  const content = disk.content(store);
  const [memory] = content.memories.apply([createMemory('old')]);
  const current = content.active.capture();
  content.active.apply({ basis: current.basis, messageIndexes: [2, 0], memoryIds: [] });
  content.close();
  store.close();
  const reopened = disk.open();
  const restored = disk.content(reopened);
  assert.deepEqual(indexes(restored.active.capture()), [2, 0]);
  const excluded = restored.active.exportState();
  restored.memories.apply([updateMemory(memory.id, 'still excluded')]);
  assert.deepEqual(restored.active.exportState(), excluded, 'an excluded memory update changes neither membership nor its revision');
  assert.deepEqual(reopened.loadContent().active, excluded, 'source persistence follows the same exclusion rule');
  restored.transcript.append(message('new'));
  const beforeBatch = restored.active.exportState();
  const [, created] = restored.memories.apply([updateMemory(memory.id, 'excluded in a mixed batch'), createMemory('new')]);
  const snapshot = restored.active.capture();
  assert.deepEqual(indexes(snapshot), [2, 0, 3]);
  assert.deepEqual(
    snapshot.memories.map((item) => item.id),
    [created.id],
  );
  assert.equal(snapshot.basis.indexRevision, beforeBatch.revision + 1, 'a mixed source batch includes only new members and advances membership once');
  assert.deepEqual(reopened.loadContent().active, restored.active.exportState());
});

test('index persistence failure rolls back source append and does not install an explicit selection', (t) => {
  const disk = diskFixture(t);
  let store = disk.open();
  disk.initialize(store, new Transcript([message('existing')]));
  store.close();
  disk.edit("CREATE TRIGGER reject_active BEFORE UPDATE ON active_content BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  store = disk.open();
  let content = disk.content(store);
  const before = content.active.capture();
  assert.throws(
    () => content.transcript.append(message('rejected')),
    (error) => error instanceof PersistenceError && error.operation === 'transcript.commit' && error.cause.code === 'PERSISTENCE_UNAVAILABLE' && /保存或加载失败/.test(error.cause.message),
  );
  assert.equal(content.transcript.length, 1);
  assert.deepEqual(content.active.capture(), before);
  assert.deepEqual(store.loadContent().active, content.active.exportState());
  content.close();
  store.close();
  store = disk.open();
  content = disk.content(store);
  const current = content.active.capture();
  assert.throws(() => content.active.apply({ basis: current.basis, messageIndexes: [], memoryIds: [] }), /保存或加载失败/);
  assert.deepEqual(content.active.capture(), current);
  assert.equal(store.failure.code, 'PERSISTENCE_UNAVAILABLE');
});

test('default inclusion is part of the same transaction as a memory batch', (t) => {
  const disk = diskFixture(t);
  let store = disk.open();
  disk.initialize(store, new Transcript([message('evidence')]));
  store.close();
  disk.edit("CREATE TRIGGER reject_active BEFORE UPDATE ON active_content BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  store = disk.open();
  const content = disk.content(store);
  const before = content.active.capture();
  assert.throws(
    () => content.memories.apply([createMemory('one'), createMemory('two')]),
    (error) => error instanceof PersistenceError && error.operation === 'memories.commit' && error.cause.code === 'PERSISTENCE_UNAVAILABLE' && /保存或加载失败/.test(error.cause.message),
  );
  assert.equal(content.memories.sequence, 0);
  assert.equal(content.memories.values().length, 0);
  assert.deepEqual(content.active.capture(), before);
  assert.equal(store.loadContent().memories.items.length, 0);
});

test('v5 migration derives only initial membership from the old active segment and current memories', (t) => {
  const disk = diskFixture(t);
  const store = disk.open();
  const transcript = new Transcript([message('old'), message('current')]);
  transcript.startSegment(1);
  disk.initialize(store, transcript);
  const content = disk.content(store);
  const [memory] = content.memories.apply([createMemory('remembered')]);
  content.close();
  store.close();
  disk.edit('DROP TABLE active_content; PRAGMA user_version = 5;');
  const reopened = disk.open();
  const restored = disk.content(reopened);
  assert.deepEqual(indexes(restored.active.capture()), [1]);
  assert.deepEqual(
    restored.active.capture().memories.map((item) => item.id),
    [memory.id],
  );
  assert.equal(restored.active.capture().basis.indexRevision, 0);
});
