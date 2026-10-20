import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ObserverConversations, SqliteObserverStore, initializeObserver } from '@capix/observer-service';
import { ChangeConsumer } from '@capix/observer-service/assembly';
import { Memories } from '@capix/server-runtime/content';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
const provider = {
  async invoke(_request, purpose) {
    return { id: 'fixture', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: '完整回答' } : { memories: [] }), finishReason: 'stop', usage: null };
  },
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-recovery-'));
  const path = join(directory, 'observer.sqlite');
  const hosts = [];
  t.after(() => {
    for (const host of hosts) host.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    open() {
      const host = new ObserverConversations(provider, [], { persistence: SqliteObserverStore.open(path) });
      hosts.push(host);
      return host;
    },
    edit(work) {
      const database = new DatabaseSync(path);
      try {
        work(database);
      } finally {
        database.close();
      }
    },
  };
}
const run = (environment, content = '提问') => environment.driver.run(environment.scene, { messages: [{ role: 'user', content }] }, { settings });

for (const [name, damage] of [
  ['identity', (database, sourceId) => database.prepare("UPDATE records SET body = json_set(body, '$.id', 'wrong') WHERE source_id = ? AND kind = 'invocation'").run(sourceId)],
  ['structure', (database, sourceId) => database.prepare("UPDATE records SET kind = 'not-a-record' WHERE source_id = ? AND kind = 'invocation'").run(sourceId)],
  ['archive', (database, sourceId) => database.prepare("UPDATE record_sources SET roots = '[]' WHERE id = ?").run(sourceId)],
]) {
  test(`damaged historical ${name} disables only that conversation's observation while healthy content continues`, async (t) => {
    const disk = fixture(t);
    const first = disk.open();
    const leftId = first.list().defaultConversationId;
    const rightId = first.create().id;
    const left = first.open(leftId);
    await run(left);
    await run(first.open(rightId), '其他对话');
    const sourceId = left.recorder.id;
    first.close();
    disk.edit((database) => damage(database, sourceId));

    const restored = disk.open();
    const content = restored.content(leftId);
    assert.equal(content.transcript.length, 2, 'content does not decode historical records');
    assert.equal(restored.peek(leftId), undefined, 'content recovery does not install recording');
    const environment = restored.open(leftId);
    assert.equal(environment.transcript, content.transcript);
    assert.equal(environment.memories, content.memories);
    assert.throws(
      () => environment.recordSource.assertComplete(),
      (error) => error.code === 'SOURCE_INCOMPLETE',
    );
    assert.equal(restored.persistence.failure, undefined);
    assert.doesNotThrow(() => restored.open(rightId).recordSource.assertComplete());
    await run(environment, '继续健康内容');
    assert.equal(content.transcript.length, 4);
    assert.equal(restored.persistence.failure, undefined);
    restored.close();
    disk.edit((database) => assert.ok(database.prepare('SELECT 1 FROM records WHERE source_id = ?').get(sourceId), 'invalid archive is retained for diagnosis'));
  });
}

test('content is recovered once and point lookups do not enumerate the directory', async (t) => {
  const disk = fixture(t);
  const first = disk.open();
  const id = first.list().defaultConversationId;
  await run(first.open(id));
  first.close();
  const restored = disk.open();
  const store = restored.persistence;
  const readContent = store.loadContent.bind(store);
  const readRecording = store.loadRecording.bind(store);
  let contentReads = 0;
  let recordingReads = 0;
  store.loadContent = (...args) => {
    contentReads++;
    return readContent(...args);
  };
  store.loadRecording = (...args) => {
    recordingReads++;
    return readRecording(...args);
  };
  store.list = () => {
    throw new Error('point lookup must not list all conversations');
  };
  const descriptor = restored.get(id);
  const content = restored.forTranscript(descriptor.transcriptId);
  assert.equal(recordingReads, 0);
  assert.equal(restored.peek(id), undefined);
  assert.equal(restored.open(id).transcript, content.transcript);
  assert.equal(restored.open(id).memories, content.memories);
  assert.equal(contentReads, 1);
  assert.equal(recordingReads, 1);
});

test('entity-level content corruption still makes required storage unavailable', (t) => {
  const disk = fixture(t);
  const first = disk.open();
  const id = first.list().defaultConversationId;
  first.close();
  disk.edit((database) => database.exec("UPDATE transcripts SET starts = '[]'"));
  const restored = disk.open();
  assert.throws(
    () => restored.content(id),
    (error) => error.code === 'PERSISTENCE_UNAVAILABLE',
  );
  assert.equal(restored.persistence.failure.code, 'PERSISTENCE_UNAVAILABLE');
});

test('an actual database schema failure during optional recovery still closes content admission', async (t) => {
  const disk = fixture(t);
  const first = disk.open();
  const id = first.list().defaultConversationId;
  await run(first.open(id));
  first.close();
  disk.edit((database) => database.exec('DROP TABLE records'));
  const restored = disk.open();
  assert.equal(restored.content(id).transcript.length, 2);
  assert.throws(
    () => restored.open(id),
    (error) => error.code === 'PERSISTENCE_UNAVAILABLE',
  );
  assert.equal(restored.persistence.failure.code, 'PERSISTENCE_UNAVAILABLE');
});

test('reusing content checks both persisted identities without reloading entity bodies', async (t) => {
  const disk = fixture(t);
  const host = disk.open();
  const id = host.list().defaultConversationId;
  const content = host.content(id);
  const originalMemoriesId = content.memories.id;
  const substituted = new Memories(content.transcript);
  host.persistence.loadContent = () => {
    throw new Error('injected content must not be reloaded');
  };
  assert.throws(() => initializeObserver(provider, [], { persistence: host.persistence, conversationId: id, content: { ...content, memories: substituted }, shared: true }), /Content belongs to another conversation/);
  assert.equal(host.persistence.failure, undefined, 'incorrect assembly is not stored-content corruption');
  assert.deepEqual(host.persistence.contentIdentity(id), { transcriptId: content.transcript.id, memoriesId: originalMemoriesId });
  const valid = host.open(id);
  assert.equal(valid.memories, content.memories);
  await run(valid);
  assert.equal(content.transcript.length, 2);
});

test('recording open failure closes only locally established content consumption', (t) => {
  const disk = fixture(t);
  const host = disk.open();
  const id = host.list().defaultConversationId;
  const content = host.content(id);
  const store = host.persistence;
  const open = store.openRecording.bind(store);
  const failure = new Error('recording installation unavailable');
  store.openRecording = () => {
    throw failure;
  };
  const originalClose = ChangeConsumer.prototype.close;
  const closed = [];
  t.mock.method(ChangeConsumer.prototype, 'close', function () {
    closed.push(this);
    return originalClose.call(this);
  });
  assert.throws(
    () => initializeObserver(provider, [], { persistence: store, conversationId: id, shared: true }),
    (error) => error === failure,
  );
  assert.equal(closed.length, 1, 'the standalone failed assembly must stop its newly created pump');
  assert.notEqual(closed[0], content.consumer);
  assert.throws(
    () => host.open(id),
    (error) => error === failure,
  );
  assert.equal(closed.length, 1, 'a failed binding does not own or close injected content');
  let observed = 0;
  const stop = content.consumer.subscribe(() => {
    observed++;
  });
  content.transcript.append({ role: 'user', content: '内容同步仍然可用' });
  content.consumer.flush();
  stop();
  assert.ok(observed > 0);
  store.openRecording = open;
  assert.equal(host.open(id).transcript, content.transcript, 'the same host content can still bind after installation recovers');
});
