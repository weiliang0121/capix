import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync } from 'node:zlib';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { PersistenceError } from '@capix/diagnostics';
import { restoreLegacyCheckpointTables } from './fixtures/checkpoint-storage.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const image = (id, contextId = 'root', parentContextId) => ({ id, formatVersion: 5, contract: { key: 'retention-fixture', version: 1 }, point: 'waiting', frame: { owner: { contextId, kind: parentContextId ? 'node' : 'scene', ...(parentContextId ? { parentContextId } : {}) }, round: 1, phase: 'execute', input: { question: 'fixed' }, currentInput: { question: 'fixed' }, nextChildOrder: 0, children: [] }, state: { text: '保留完整的当前依据🙂'.repeat(100) }, references: {} });
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

function stored(value) {
  const json = Buffer.from(JSON.stringify(value));
  return JSON.stringify({ encoding: 'br', jsonBytes: json.byteLength, data: brotliCompressSync(json).toString('base64') });
}

function snapshot(database) {
  return {
    version: database.prepare('PRAGMA user_version').get().user_version,
    schema: database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
    images: database.prepare('SELECT * FROM checkpoint_images ORDER BY rowid').all(),
    heads: database.prepare('SELECT * FROM checkpoint_heads ORDER BY rowid').all(),
    usage: database.prepare('SELECT * FROM archive_usage').all(),
  };
}

function legacy(t) {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  content.transcript.append({ role: 'user', content: '正式内容保留' });
  const first = image('first');
  const child = image('child-first', 'child', 'root');
  const second = { ...image('second'), point: 'completed' };
  const result = delivery();
  store.checkpoints.save(first, 0);
  store.checkpoints.save(child, 0);
  const savedContent = store.load();
  store.close();
  files.sql((database) => {
    restoreLegacyCheckpointTables(database);
    database.prepare('INSERT INTO checkpoint_images VALUES (?, ?, ?, ?)').run(second.id, 'root', 2, stored(second));
    database.prepare('UPDATE checkpoint_heads SET revision = 3, image_id = ?, delivery = ? WHERE context_id = ?').run(second.id, stored(result), 'root');
    database.exec('PRAGMA user_version = 5');
  });
  return { files, first, second, child, result, savedContent };
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
  assert.equal(store.archiveUsage().checkpointBytes, bytes(third) + bytes(child) + bytes(result));
  assert.deepEqual(store.checkpoints.read('child'), { revision: 2, image: child, delivery: result });
  assert.deepEqual(store.checkpoints.read('root'), { revision: 3, image: third });
  store.close();
  files.sql((database) => {
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
  assert.deepEqual(reopened.checkpoints.read('child'), { revision: 2, image: child, delivery: result });
  reopened.checkpoints.finish('root', 3, result);
  const final = reopened.checkpoints.read('root');
  assert.deepEqual(final, { revision: 4, image: third, delivery: result });
  assert.equal(reopened.archiveUsage().checkpointBytes, bytes(third) + bytes(child) + 2 * bytes(result));
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
  assert.deepEqual(reopened.checkpoints.read('root'), { revision: 1, image: first });
  assert.equal(reopened.archiveUsage().checkpointBytes, bytes(first));
  // The failed transaction reserved no identity, so the exact attempted image may be saved.
  reopened.checkpoints.save(second, 1);
  assert.deepEqual(reopened.checkpoints.read('root'), { revision: 2, image: second });
  assert.equal(reopened.archiveUsage().checkpointBytes, bytes(second));
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

test('v5 migration retains exact head bytes, deliveries and identities, subtracts superseded JSON and preserves content', (t) => {
  const { files, first, second, child, result, savedContent } = legacy(t);
  const before = files.sql(snapshot);
  assert.equal(before.usage[0].checkpoint_bytes, bytes(first) + bytes(second) + bytes(child) + bytes(result));
  const migrated = files.open();
  assert.deepEqual(migrated.load(), savedContent);
  assert.deepEqual(migrated.checkpoints.read('root'), { revision: 3, image: second, delivery: result });
  assert.deepEqual(migrated.checkpoints.read('child'), { revision: 1, image: child });
  assert.equal(migrated.archiveUsage().checkpointBytes, before.usage[0].checkpoint_bytes - bytes(first));
  assert.throws(() => migrated.checkpoints.save(image('first', 'new-context'), 0), { code: 'CHECKPOINT_CONFLICT' });
  migrated.assertAvailable();
  migrated.close();
  files.sql((database) => {
    const after = snapshot(database);
    assert.equal(after.version, 6);
    assert.deepEqual(after.heads, before.heads);
    assert.deepEqual(
      after.images.map((row) => ({ ...row })),
      before.images.map((row) => ({ ...row, body: row.id === first.id ? null : row.body })),
    );
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  });
  const reopened = files.open();
  assert.deepEqual(reopened.checkpoints.read('root'), { revision: 3, image: second, delivery: result });
  assert.equal(reopened.archiveUsage().checkpointBytes, bytes(second) + bytes(child) + bytes(result));
});

const migrationFaults = {
  'historical row identity': (database) => database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(stored(image('different-id')), 'first'),
  'historical owner identity': (database) => database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(stored(image('first', 'different-context')), 'first'),
  'changed historical owner relation': (database) => database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(stored(image('first', 'root', 'different-parent')), 'first'),
  'changed historical contract': (database) => database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(stored({ ...image('first'), contract: { key: 'retention-fixture', version: 2 } }), 'first'),
  'changed historical original input': (database) => {
    const changed = image('first');
    changed.frame.input = { question: 'different' };
    database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(stored(changed), 'first');
  },
  'corrupt historical encoding': (database) => database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(JSON.stringify({ encoding: 'br', jsonBytes: 100, data: 'AAAA' }), 'first'),
  'orphan history': (database) => database.prepare('INSERT INTO checkpoint_images VALUES (?, ?, ?, ?)').run('orphan', 'missing-head', 1, stored(image('orphan', 'missing-head'))),
  'nonlatest head': (database) => database.prepare('INSERT INTO checkpoint_images VALUES (?, ?, ?, ?)').run('future-image', 'root', 3, stored(image('future-image'))),
  'revision gap': (database) => database.exec("UPDATE checkpoint_images SET revision = 3 WHERE id = 'second'; UPDATE checkpoint_heads SET revision = 4 WHERE context_id = 'root'"),
  'delivery revision': (database) => database.exec("UPDATE checkpoint_heads SET revision = 2 WHERE context_id = 'root'"),
  'incorrect archive counter': (database) => database.exec('UPDATE archive_usage SET checkpoint_bytes = checkpoint_bytes + 1'),
};

for (const [name, damage] of Object.entries(migrationFaults)) {
  test(`v5 migration rejects ${name} before it can hide the damaged history`, (t) => {
    const { files } = legacy(t);
    files.sql(damage);
    const before = files.sql(snapshot);
    assert.throws(() => files.open(), PersistenceError);
    assert.deepEqual(files.sql(snapshot), before);
  });
}
