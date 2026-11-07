import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CHECKPOINT_MAX_BYTES } from '@capix/checkpoint';
import { SqliteCheckpointStore } from '@capix/observer-service/assembly';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-checkpoint-'));
  const path = join(directory, 'checkpoints.sqlite');
  const databases = [];
  t.after(() => {
    for (const database of databases) if (database.isOpen) database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    raw() {
      const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      databases.push(database);
      return database;
    },
    open() {
      const database = new DatabaseSync(path, { enableForeignKeyConstraints: true });
      databases.push(database);
      return { database, store: new SqliteCheckpointStore(database) };
    },
  };
}

function image(id = 'cp-1', contextId = 'context-1') {
  return {
    id,
    formatVersion: 6,
    contract: { key: 'fixture.request-model', version: 1 },
    point: 'feedback-accepted',
    frame: { owner: { contextId, kind: 'group', parentContextId: 'parent-1' }, round: 1, phase: 'execute', input: { model: 'fixture', content: 'fixed input' }, currentInput: { model: 'fixture', content: 'fixed input' }, nextChildOrder: 0, children: [] },
    state: { output: { content: 'fixed output' } },
    references: {},
  };
}

test('checkpoint identities and the latest image survive reopening while superseded bodies retire', (t) => {
  const disk = fixture(t);
  const first = disk.open();
  assert.equal(first.store.read('missing'), undefined);
  const source = image();
  const receipt = first.store.save(source, 0);
  const saved = first.store.read('context-1');
  assert.equal(receipt.kind, 'saved');
  assert.equal(receipt.contextId, 'context-1');
  assert.equal(receipt.checkpointId, 'cp-1');
  assert.equal(receipt.revision, saved.revision);
  assert.equal('image' in receipt, false);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.image, source);
  source.state.output.content = 'caller mutation';
  assert.equal(saved.image.state.output.content, 'fixed output');
  assert.equal(Object.isFrozen(saved.image.state.output), true);
  const second = image('cp-2');
  second.point = 'after-feedback';
  second.state = { result: 'next state' };
  first.store.save(second, 1);
  const latest = first.store.read('context-1');
  assert.equal(latest.revision, 2);
  assert.equal(first.database.prepare('SELECT count(*) AS count FROM checkpoint_images').get().count, 2);
  first.database.close();
  const reopened = disk.open();
  assert.deepEqual(reopened.store.read('context-1'), latest);
  assert.equal(reopened.database.prepare('SELECT body FROM checkpoint_images WHERE id = ?').get('cp-1').body, null);
  assert.throws(() => reopened.store.save(image('cp-1'), 2), { code: 'CHECKPOINT_CONFLICT' });
  assert.throws(() => reopened.store.save(image('cp-1', 'context-2'), 0), { code: 'CHECKPOINT_CONFLICT' });
});

test('stale checkpoint writers cannot overwrite the current head or leave orphan images', (t) => {
  const { database, store } = fixture(t).open();
  const other = new SqliteCheckpointStore(database);
  store.save(image(), 0);
  const saved = store.read('context-1');
  assert.throws(() => other.save(image('stale'), 0), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(database.prepare('SELECT count(*) AS count FROM checkpoint_images').get().count, 1);
  assert.deepEqual(store.read('context-1'), saved);
  assert.equal(other.save(image('cp-2'), 1).revision, 2);
  assert.throws(() => store.finish('context-1', 1, { status: 'succeeded', output: 'stale', progress: { round: 1, phase: 'receive', currentInput: {} } }), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(store.read('context-1').delivery, undefined);
});

test('duplicate checkpoint identities never replace an immutable body or advance a different scope', (t) => {
  const { database, store } = fixture(t).open();
  store.save(image(), 0);
  const saved = store.read('context-1');
  assert.throws(() => store.save(image(), 1), { code: 'CHECKPOINT_CONFLICT' });
  const replacement = image();
  replacement.state = { changed: true };
  assert.throws(() => store.save(replacement, 1), { code: 'CHECKPOINT_CONFLICT' });
  assert.throws(() => store.save(image('cp-1', 'context-2'), 0), { code: 'CHECKPOINT_CONFLICT' });
  assert.deepEqual(store.read('context-1'), saved);
  assert.equal(store.read('context-2'), undefined);
  assert.equal(database.prepare('SELECT count(*) AS count FROM checkpoint_images').get().count, 1);
});

for (const [label, mutate] of [
  ['owner kind', (next) => (next.frame.owner.kind = 'node')],
  ['direct parent', (next) => (next.frame.owner.parentContextId = 'other-parent')],
  ['declaration contract', (next) => (next.contract.key = 'other-contract')],
  ['declaration version', (next) => (next.contract.version = 2)],
  ['original input', (next) => (next.frame.input = { changed: true })],
]) {
  test(`checkpoint advancement preserves ${label}`, (t) => {
    const { store } = fixture(t).open();
    store.save(image(), 0);
    const saved = store.read('context-1');
    const next = image('cp-2');
    mutate(next);
    assert.throws(() => store.save(next, 1), { code: 'CHECKPOINT_CONFLICT' });
    assert.deepEqual(store.read('context-1'), saved);
  });
}

for (const delivery of [{ status: 'succeeded', output: { content: 'final delivery, not execute output' }, progress: { round: 1, phase: 'receive', currentInput: { final: true } } }, { status: 'failed' }, { status: 'cancelled' }]) {
  test(`checkpoint ${delivery.status} delivery is durable and closes further advancement`, (t) => {
    const disk = fixture(t);
    const first = disk.open();
    first.store.save(image(), 0);
    const receipt = first.store.finish('context-1', 1, delivery);
    const finished = first.store.read('context-1');
    assert.equal(receipt.kind, 'finished');
    assert.equal(receipt.contextId, 'context-1');
    assert.equal(receipt.checkpointId, 'cp-1');
    assert.equal(receipt.revision, finished.revision);
    assert.equal(receipt.status, delivery.status);
    assert.equal('delivery' in receipt, false);
    assert.equal(finished.revision, 2);
    assert.deepEqual(finished.delivery, delivery);
    assert.equal(finished.image.state.output.content, 'fixed output');
    assert.throws(() => first.store.save(image('cp-2'), 2), { code: 'CHECKPOINT_CONFLICT' });
    assert.throws(() => first.store.finish('context-1', 2, delivery), { code: 'CHECKPOINT_CONFLICT' });
    first.database.close();
    assert.deepEqual(disk.open().store.read('context-1'), finished);
  });
}

test('checkpoint terminal save requires an existing scope and valid revision', (t) => {
  const { store } = fixture(t).open();
  assert.throws(() => store.finish('absent', 0, { status: 'failed' }), { code: 'CHECKPOINT_CONFLICT' });
  for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER, Infinity]) assert.throws(() => store.save(image(), revision), TypeError);
  assert.equal(store.read('context-1'), undefined);
});

test('checkpoint persistence rejects live values without invoking caller accessors or serialization hooks', (t) => {
  const { database, store } = fixture(t).open();
  let evaluated = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() {
      evaluated += 1;
      return 'unsafe';
    },
  });
  const cycle = {};
  cycle.self = cycle;
  for (const state of [accessor, cycle, { callback: () => 1 }, { value: Infinity }, new Date(), { toJSON: () => evaluated++ }]) {
    const invalid = image();
    invalid.state = state;
    assert.throws(() => store.save(invalid, 0));
  }
  assert.equal(evaluated, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM checkpoint_images').get().count, 0);
  assert.equal(store.read('context-1'), undefined);
});

test('failure to install the head rolls back the immutable image in the same transaction', (t) => {
  const { database, store } = fixture(t).open();
  database.exec("CREATE TRIGGER reject_checkpoint_head BEFORE INSERT ON checkpoint_heads BEGIN SELECT RAISE(ABORT, 'fixture'); END;");
  assert.throws(() => store.save(image(), 0), { code: 'CHECKPOINT_STORAGE_FAILURE' });
  assert.equal(database.prepare('SELECT count(*) AS count FROM checkpoint_images').get().count, 0);
  assert.equal(store.read('context-1'), undefined);
  database.exec('DROP TRIGGER reject_checkpoint_head');
  assert.equal(store.save(image(), 0).revision, 1);
});

test('silently suppressed head updates cannot claim a successful checkpoint or final delivery', (t) => {
  const { database, store } = fixture(t).open();
  store.save(image(), 0);
  const saved = store.read('context-1');
  database.exec('CREATE TRIGGER skip_checkpoint_head BEFORE UPDATE ON checkpoint_heads BEGIN SELECT RAISE(IGNORE); END;');
  assert.throws(() => store.save(image('cp-2'), 1), { code: 'CHECKPOINT_STORAGE_FAILURE' });
  assert.throws(() => store.finish('context-1', 1, { status: 'succeeded', output: 'not persisted', progress: { round: 1, phase: 'receive', currentInput: {} } }), { code: 'CHECKPOINT_STORAGE_FAILURE' });
  assert.deepEqual(store.read('context-1'), saved);
  assert.equal(database.prepare('SELECT count(*) AS count FROM checkpoint_images').get().count, 1);
});

test('checkpoint failure does not roll back a transaction owned by the host', (t) => {
  const { database, store } = fixture(t).open();
  database.exec("CREATE TABLE host_data (value TEXT); BEGIN; INSERT INTO host_data VALUES ('keep');");
  assert.throws(() => store.save(image(), 0), { code: 'CHECKPOINT_STORAGE_FAILURE' });
  assert.equal(database.isTransaction, true);
  database.exec('COMMIT');
  assert.equal(database.prepare('SELECT value FROM host_data').get().value, 'keep');
  assert.equal(store.read('context-1'), undefined);
});

for (const [label, mutate] of [
  ...[1, 2, 3, 4, 5].map((formatVersion) => [`unsupported format v${formatVersion}`, (database) => database.prepare('UPDATE checkpoint_images SET body = ?').run(JSON.stringify({ ...image(), formatVersion }))]),
  ['malformed image JSON', (database) => database.prepare('UPDATE checkpoint_images SET body = ?').run('{ broken')],
  ['image identity mismatch', (database) => database.prepare('UPDATE checkpoint_images SET body = ?').run(JSON.stringify(image('other-id')))],
  ['image context mismatch', (database) => database.prepare('UPDATE checkpoint_images SET context_id = ?').run('other-context')],
  ['invalid frame', (database) => database.prepare('UPDATE checkpoint_images SET body = ?').run(JSON.stringify({ ...image(), frame: {} }))],
  ['head body missing', (database) => database.exec('UPDATE checkpoint_images SET body = NULL')],
  ['head version mismatch', (database) => database.exec('UPDATE checkpoint_heads SET revision = 8')],
  ['head missing', (database) => database.exec('DELETE FROM checkpoint_heads')],
  ['malformed final delivery', (database) => database.prepare('UPDATE checkpoint_heads SET revision = 2, delivery = ?').run('{ broken')],
  ['invalid final delivery', (database) => database.prepare('UPDATE checkpoint_heads SET revision = 2, delivery = ?').run(JSON.stringify({ status: 'succeeded' }))],
]) {
  test(`stored checkpoint rejects ${label}`, (t) => {
    const disk = fixture(t);
    const first = disk.open();
    first.store.save(image(), 0);
    mutate(first.database);
    first.database.close();
    const code = 'CHECKPOINT_STORAGE_FAILURE';
    const reopened = disk.open();
    assert.throws(() => reopened.store.read('context-1'), { code });
    assert.throws(() => reopened.store.save(image('cp-2'), 1), { code });
  });
}

test('checkpoint reads fail explicitly after the host closes its connection', (t) => {
  const { database, store } = fixture(t).open();
  store.save(image(), 0);
  database.close();
  assert.throws(() => store.read('context-1'), { code: 'CHECKPOINT_STORAGE_FAILURE' });
});

test('stored checkpoint bodies are bounded before JSON parsing', (t) => {
  const { database, store } = fixture(t).open();
  store.save(image(), 0);
  database.prepare('UPDATE checkpoint_images SET body = ?').run(' '.repeat(CHECKPOINT_MAX_BYTES + 1));
  assert.throws(
    () => store.read('context-1'),
    (error) => error.code === 'CHECKPOINT_STORAGE_FAILURE' && error.cause.message.includes('byte limit'),
  );
});

const legacySchema = `CREATE TABLE checkpoint_images (
    id TEXT PRIMARY KEY, context_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK (revision > 0),
    body TEXT NOT NULL, UNIQUE (context_id, revision));
    CREATE TABLE checkpoint_heads (
      context_id TEXT PRIMARY KEY, revision INTEGER NOT NULL CHECK (revision > 0),
      image_id TEXT NOT NULL REFERENCES checkpoint_images(id), delivery TEXT);
    PRAGMA user_version = 6;`;

function installLegacy(database, formatVersion = 5) {
  database.exec(legacySchema);
  const old = { ...image('old'), formatVersion };
  const latest = { ...image('latest'), formatVersion, state: { final: true } };
  const other = image('other-image', 'context-2');
  const insert = database.prepare('INSERT INTO checkpoint_images VALUES (?, ?, ?, ?)');
  insert.run('old', 'context-1', 1, JSON.stringify(old));
  insert.run('latest', 'context-1', 2, JSON.stringify(latest));
  insert.run('other-image', 'context-2', 1, JSON.stringify(other));
  const delivery = { status: 'succeeded', output: 'delivered', progress: { round: 1, phase: 'execute', currentInput: latest.frame.input } };
  database.prepare('INSERT INTO checkpoint_heads VALUES (?, ?, ?, ?)').run('context-1', 3, 'latest', JSON.stringify(delivery));
  database.prepare('INSERT INTO checkpoint_heads VALUES (?, ?, ?, NULL)').run('context-2', 1, 'other-image');
  return { old, latest, other, delivery };
}

function savedArchive(database) {
  return {
    images: database.prepare('SELECT * FROM checkpoint_images ORDER BY id').all(),
    heads: database.prepare('SELECT * FROM checkpoint_heads ORDER BY context_id').all(),
    version: database.prepare('PRAGMA user_version').get().user_version,
    bodyNotNull: database
      .prepare('PRAGMA table_info(checkpoint_images)')
      .all()
      .find((row) => row.name === 'body').notnull,
  };
}

for (const nullable of [false, true]) {
  for (const [label, change] of [
    ['body type', (sql) => sql.replace('body TEXT', 'body BLOB')],
    ['context nullability', (sql) => sql.replace('context_id TEXT NOT NULL', 'context_id TEXT')],
    ['head primary key', (sql) => sql.replace('context_id TEXT PRIMARY KEY', 'context_id TEXT')],
    ['missing head foreign key', (sql) => sql.replace(' REFERENCES checkpoint_images(id)', '')],
    ['foreign key action', (sql) => sql.replace('REFERENCES checkpoint_images(id)', 'REFERENCES checkpoint_images(id) ON DELETE CASCADE')],
    ['revision uniqueness', (sql) => sql.replace(', UNIQUE (context_id, revision)', '')],
  ]) {
    test(`Observer refuses unknown ${nullable ? 'nullable' : 'legacy'} schema ${label} without modifying storage`, (t) => {
      const database = fixture(t).raw();
      database.exec(change(nullable ? legacySchema.replace('body TEXT NOT NULL', 'body TEXT') : legacySchema));
      const before = savedArchive(database);
      const schema = database.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
      assert.throws(() => new SqliteCheckpointStore(database), { code: 'CHECKPOINT_STORAGE_FAILURE' });
      assert.deepEqual(savedArchive(database), before);
      assert.deepEqual(database.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schema);
      assert.equal(database.isTransaction, false);
    });
  }
}

for (const [label, index] of [
  ['wrong column', 'CREATE INDEX checkpoint_heads_image ON checkpoint_heads(revision)'],
  ['wrong table', 'CREATE INDEX checkpoint_heads_image ON checkpoint_images(id)'],
  ['partial index', 'CREATE INDEX checkpoint_heads_image ON checkpoint_heads(image_id) WHERE delivery IS NULL'],
]) {
  test(`Observer rejects a same-named head index with ${label} before accepting the schema`, (t) => {
    const database = fixture(t).raw();
    database.exec(legacySchema.replace('body TEXT NOT NULL', 'body TEXT'));
    database.exec(index);
    const before = savedArchive(database);
    const schema = database.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
    assert.throws(() => new SqliteCheckpointStore(database), { code: 'CHECKPOINT_STORAGE_FAILURE' });
    assert.deepEqual(savedArchive(database), before);
    assert.deepEqual(database.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schema);
    assert.equal(database.isTransaction, false);
  });
}

for (const formatVersion of [4, 5]) {
  test(`Observer refuses old checkpoint tables and format ${formatVersion} without modifying any data`, (t) => {
    const database = fixture(t).raw();
    installLegacy(database, formatVersion);
    const before = savedArchive(database);
    const schema = database.prepare('SELECT * FROM sqlite_master ORDER BY name').all();
    assert.throws(() => new SqliteCheckpointStore(database), { code: 'CHECKPOINT_STORAGE_FAILURE' });
    assert.deepEqual(savedArchive(database), before);
    assert.deepEqual(database.prepare('SELECT * FROM sqlite_master ORDER BY name').all(), schema);
    assert.equal(database.isTransaction, false);
  });
}

for (const result of ["ABORT, 'retirement failed'", 'IGNORE']) {
  test(`Observer old-body retirement ${result} rolls back new image and head advancement`, (t) => {
    const { database, store } = fixture(t).open();
    store.save(image(), 0);
    const before = savedArchive(database);
    database.exec(`CREATE TRIGGER fail_retirement BEFORE UPDATE OF body ON checkpoint_images WHEN NEW.body IS NULL BEGIN SELECT RAISE(${result}); END;`);
    assert.throws(() => store.save(image('cp-2'), 1), { code: 'CHECKPOINT_STORAGE_FAILURE' });
    assert.deepEqual(savedArchive(database), before);
    database.exec('DROP TRIGGER fail_retirement');
    assert.equal(store.save(image('cp-2'), 1).revision, 2);
    assert.equal(database.prepare('SELECT body FROM checkpoint_images WHERE id = ?').get('cp-1').body, null);
  });
}

test('Observer opening does not rewrite unknown obsolete bodies', (t) => {
  const { database, store } = fixture(t).open();
  store.save(image(), 0);
  store.save(image('cp-2'), 1);
  const head = store.read('context-1');
  database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run('{unknown old writer}', 'cp-1');
  const before = savedArchive(database);
  const reopened = new SqliteCheckpointStore(database);
  assert.deepEqual(savedArchive(database), before);
  assert.deepEqual(reopened.read('context-1'), head);
  assert.throws(() => reopened.save(image('cp-1', 'another'), 0), { code: 'CHECKPOINT_CONFLICT' });
});
