import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { retainedCheckpointBytes } from './fixtures/checkpoint-accounting.mjs';

const image = (id, contextId = 'root', parentContextId) => ({ id, formatVersion: 6, contract: { key: 'retention-fixture', version: 1 }, point: 'waiting', frame: { owner: { contextId, kind: parentContextId ? 'node' : 'scene', ...(parentContextId ? { parentContextId } : {}) }, round: 1, phase: 'execute', input: { question: 'fixed' }, currentInput: { question: 'fixed' }, nextChildOrder: 0, children: [] }, state: { text: '保留完整的当前依据🙂'.repeat(100) }, references: {} });
const delivery = () => ({ status: 'succeeded', output: 'accepted', progress: { round: 1, currentInput: { question: 'fixed' }, phase: 'execute' } });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-cp-retention-'));
  const path = join(directory, 'conversation.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    open() {
      const store = ConversationStore.open(path);
      stores.push(store);
      return store;
    },
    sql(work) {
      const database = new DatabaseSync(path);
      try {
        database.exec('PRAGMA foreign_keys = ON');
        return work(database);
      } finally {
        database.close();
      }
    },
  };
}

function snapshot(database) {
  return {
    version: database.prepare('PRAGMA user_version').get().user_version,
    schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
    images: database.prepare('SELECT * FROM checkpoint_images ORDER BY rowid').all(),
    heads: database.prepare('SELECT * FROM checkpoint_heads ORDER BY rowid').all(),
    usage: database.prepare('SELECT * FROM archive_usage').all(),
    retainedBytes: retainedCheckpointBytes(database),
  };
}

function logicalHead(head) {
  assert.ok(head.publication, 'v6 heads retain their authenticated incremental publication');
  const { publication: _publication, ...logical } = head;
  return logical;
}

test('only each invocation head retains its body while old image identities stay reserved across contexts and reopen', (t) => {
  const files = fixture(t);
  const store = files.open();
  loadConversationContent(store);
  const first = image('first');
  const second = image('second');
  const third = image('third');
  const child = image('child-image', 'child', 'root');
  store.checkpoints.save(first, 0);
  store.checkpoints.save(child, 0);
  store.checkpoints.save(second, 1);
  store.checkpoints.save(third, 2);
  const result = delivery();
  store.checkpoints.finish('child', 1, result);
  const expectedUsage = store.archiveUsage().checkpointBytes;
  assert.deepEqual(logicalHead(store.checkpoints.read('child')), { revision: 2, image: child, delivery: result });
  assert.deepEqual(logicalHead(store.checkpoints.read('root')), { revision: 3, image: third });
  store.close();
  files.sql((database) => {
    assert.equal(retainedCheckpointBytes(database), expectedUsage);
    assert.deepEqual(
      database
        .prepare('SELECT id, context_id, revision, body IS NOT NULL AS retained FROM checkpoint_images ORDER BY rowid')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 'first', context_id: 'root', revision: 1, retained: 0 },
        { id: 'child-image', context_id: 'child', revision: 1, retained: 1 },
        { id: 'second', context_id: 'root', revision: 2, retained: 0 },
        { id: 'third', context_id: 'root', revision: 3, retained: 1 },
      ],
    );
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  });
  const reopened = files.open();
  assert.throws(() => reopened.checkpoints.save(image('first'), 3), { code: 'CHECKPOINT_CONFLICT' });
  assert.throws(() => reopened.checkpoints.save(image('second', 'another-context'), 0), { code: 'CHECKPOINT_CONFLICT' });
  assert.throws(() => reopened.checkpoints.save(image('child-next', 'child', 'root'), 2), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(reopened.checkpoints.read('another-context'), undefined);
  reopened.assertAvailable();
  assert.deepEqual(logicalHead(reopened.checkpoints.read('child')), { revision: 2, image: child, delivery: result });
  reopened.checkpoints.finish('root', 3, result);
  const final = reopened.checkpoints.read('root');
  assert.deepEqual(logicalHead(final), { revision: 4, image: third, delivery: result });
  const finalUsage = reopened.archiveUsage().checkpointBytes;
  assert.ok(finalUsage > expectedUsage);
  reopened.close();
  assert.equal(files.sql(retainedCheckpointBytes), finalUsage);
});

test('rejected CAS or changed original input releases no body and changes no persisted counter', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  initial.checkpoints.save(image('first'), 0);
  initial.close();
  const before = files.sql(snapshot);
  const store = files.open();
  assert.throws(() => store.checkpoints.save(image('stale'), 0), { code: 'CHECKPOINT_CONFLICT' });
  const changed = image('changed-input');
  changed.frame.input = { question: 'different' };
  assert.throws(() => store.checkpoints.save(changed, 1), { code: 'CHECKPOINT_CONFLICT' });
  store.assertAvailable();
  store.close();
  assert.deepEqual(files.sql(snapshot), before);
});

test('body-release failure rolls back the new image, advanced head and both usage updates', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  const first = image('first');
  const second = image('second');
  initial.checkpoints.save(first, 0);
  initial.close();
  files.sql((database) => database.exec("CREATE TRIGGER reject_release BEFORE UPDATE OF body ON checkpoint_images WHEN OLD.id = 'first' AND NEW.body IS NULL BEGIN SELECT RAISE(ABORT, 'release failure'); END"));
  const before = files.sql(snapshot);
  const store = files.open();
  assert.throws(() => store.checkpoints.save(second, 1), PersistenceError);
  assert.throws(() => store.assertAvailable(), PersistenceError);
  store.close();
  assert.deepEqual(files.sql(snapshot), before);
  files.sql((database) => database.exec('DROP TRIGGER reject_release'));
  const reopened = files.open();
  assert.deepEqual(logicalHead(reopened.checkpoints.read('root')), { revision: 1, image: first });
  assert.equal(reopened.archiveUsage().checkpointBytes, before.retainedBytes);
  // The failed transaction reserved no identity, so the exact attempted image may be saved.
  reopened.checkpoints.save(second, 1);
  assert.deepEqual(logicalHead(reopened.checkpoints.read('root')), { revision: 2, image: second });
  const afterUsage = reopened.archiveUsage().checkpointBytes;
  reopened.close();
  assert.equal(files.sql(retainedCheckpointBytes), afterUsage);
});

for (const method of ['read', 'listRoots']) {
  test(`a NULL current body is damaged storage, not an unavailable checkpoint (${method})`, (t) => {
    const files = fixture(t);
    const initial = files.open();
    loadConversationContent(initial);
    initial.checkpoints.save(image('first'), 0);
    initial.close();
    files.sql((database) => database.prepare('UPDATE checkpoint_images SET body = NULL WHERE id = ?').run('first'));
    const store = files.open();
    assert.throws(() => store.checkpoints[method]('root'), PersistenceError);
    assert.throws(() => store.assertAvailable(), PersistenceError);
  });
}
