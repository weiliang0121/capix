import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ChangeBuffer } from '@capix/server-runtime';
import { Transcript, Memories } from '@capix/server-runtime/content';
import { SqliteObserverStore } from '@capix/observer-service';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-fixed-append-'));
  const path = join(directory, 'observer.sqlite');
  const stores = [];
  t.after(() => {
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
    edit(work) {
      const database = new DatabaseSync(path);
      try {
        return work(database);
      } finally {
        database.close();
      }
    },
  };
}

function create(store, changes) {
  const original = new Transcript([{ role: 'user', content: 'question' }]);
  store.initialize({ transcript: original.exportState(), memories: new Memories(original).exportState() });
  return Transcript.restore(original.exportState(), { persistence: store.transcript, changes });
}

function request(transcript) {
  return { contract: { key: 'transcript.append', version: 1 }, operation: { parentContextId: 'parent-work', childContextId: 'answer-work', position: 'answer-message' }, transcriptId: transcript.id, messages: [{ role: 'assistant', content: 'committed answer' }] };
}

test('SQLite restores an original fixed append receipt after publication fails, without appending or publishing again', (t) => {
  const disk = fixture(t);
  const store = disk.open();
  const transcript = create(store, {
    capture() {
      throw new Error('lost delivery after commit');
    },
  });
  const input = request(transcript);
  assert.throws(
    () => transcript.applyFixed(input),
    (error) => error.code === 'CHANGE_CAPTURE_FAILED' && error.cause.message === 'lost delivery after commit',
  );
  const receipt = transcript.confirmFixed(input);
  store.close();
  const reopened = disk.open();
  const changes = new ChangeBuffer();
  const restored = Transcript.restore(reopened.loadContent().transcript, { persistence: reopened.transcript, changes });
  assert.deepEqual(restored.confirmFixed(input), receipt);
  assert.deepEqual(restored.applyFixed(input), receipt);
  assert.equal(restored.length, 2);
  assert.equal(restored.revision, 2);
  assert.equal(changes.size, 0);
  assert.throws(() => restored.applyFixed({ ...input, messages: [{ role: 'assistant', content: 'different answer' }] }), { code: 'TRANSCRIPT_APPEND_CONFLICT' });
  assert.equal(reopened.failure, undefined, 'a known operation conflict does not become a database failure');
  restored.append({ role: 'user', content: 'later work' });
  assert.deepEqual(restored.applyFixed(input), receipt, 'uses the original index despite later messages');
  reopened.close();
  disk.edit((database) => {
    assert.equal(database.prepare('SELECT count(*) AS count FROM messages').get().count, 3);
    assert.equal(database.prepare('SELECT count(*) AS count FROM transcript_appends').get().count, 1);
  });
});

test('SQLite message mutation and fixed receipt roll back together when receipt persistence fails', (t) => {
  const disk = fixture(t);
  disk.open().close();
  disk.edit((database) => database.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON transcript_appends BEGIN SELECT RAISE(ABORT, 'receipt write failed'); END;"));
  const store = disk.open();
  const transcript = create(store);
  const input = request(transcript);
  assert.throws(() => transcript.applyFixed(input), /保存或加载失败/);
  assert.equal(transcript.length, 1);
  assert.equal(transcript.confirmFixed(input), undefined);
  assert.equal(transcript.revision, 1);
  store.close();
  disk.edit((database) => {
    assert.equal(database.prepare('SELECT count(*) AS count FROM messages').get().count, 1);
    assert.equal(database.prepare('SELECT count(*) AS count FROM transcript_appends').get().count, 0);
    assert.equal(database.prepare('SELECT revision FROM transcripts').get().revision, 1);
    database.exec('DROP TRIGGER reject_receipt');
  });
  const reopened = disk.open();
  const restored = Transcript.restore(reopened.loadContent().transcript, { persistence: reopened.transcript });
  assert.equal(restored.applyFixed(input).start, 1);
});

test('v3 migration preserves prior messages and adds no fictitious operation receipts', (t) => {
  const disk = fixture(t);
  const store = disk.open();
  const transcript = create(store);
  const expected = transcript.exportState();
  store.close();
  disk.edit((database) => database.exec('DROP TABLE transcript_appends; DROP TABLE memory_applies; DROP TABLE file_creations; PRAGMA user_version = 3;'));
  const migrated = disk.open();
  assert.deepEqual(migrated.loadContent().transcript, expected);
  const restored = Transcript.restore(migrated.loadContent().transcript, { persistence: migrated.transcript });
  assert.equal(restored.confirmFixed(request(restored)), undefined);
  assert.equal(restored.applyFixed(request(restored)).start, 1);
  migrated.close();
  disk.edit((database) => assert.equal(database.prepare('PRAGMA user_version').get().user_version, 6));
});

test('saved fixed receipt identity and actual message body are checked independently', (t) => {
  const disk = fixture(t);
  const store = disk.open();
  const transcript = create(store);
  transcript.applyFixed(request(transcript));
  store.close();
  disk.edit((database) => database.exec("UPDATE transcript_appends SET body = json_set(body, '$.receipt.start', 0)"));
  const reopened = disk.open();
  assert.throws(() => Transcript.restore(reopened.loadContent().transcript), /does not match messages/);
  reopened.close();
  disk.edit((database) => database.exec("UPDATE transcript_appends SET body = json_set(body, '$.request.operation.childContextId', 'other-child')"));
  const corrupted = disk.open();
  assert.throws(() => corrupted.loadContent(), /保存或加载失败/);
});
