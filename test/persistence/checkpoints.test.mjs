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
    formatVersion: 5,
    contract: { key: 'fixture.request-model', version: 1 },
    point: 'feedback-accepted',
    frame: { owner: { contextId, kind: 'group', parentContextId: 'parent-1' }, round: 1, phase: 'execute', input: { model: 'fixture', content: 'fixed input' }, currentInput: { model: 'fixture', content: 'fixed input' }, nextChildOrder: 0, children: [] },
    state: { output: { content: 'fixed output' } },
    references: {},
  };
}

test('checkpoint images and the latest version survive closing and reopening the host database', (t) => {
  const disk = fixture(t);
  const first = disk.open();
  assert.equal(first.store.read('missing'), undefined);
  const source = image();
  const saved = first.store.save(source, 0);
  assert.equal(saved.revision, 1);
  assert.deepEqual(saved.image, source);
  source.state.output.content = 'caller mutation';
  assert.equal(saved.image.state.output.content, 'fixed output');
  assert.equal(Object.isFrozen(saved.image.state.output), true);
  const second = image('cp-2');
  second.point = 'after-feedback';
  second.state = { result: 'next state' };
  const latest = first.store.save(second, 1);
  assert.equal(latest.revision, 2);
  assert.equal(first.database.prepare('SELECT count(*) AS count FROM checkpoint_images').get().count, 2);
  first.database.close();
  const reopened = disk.open();
  assert.deepEqual(reopened.store.read('context-1'), latest);
  assert.equal(JSON.parse(reopened.database.prepare('SELECT body FROM checkpoint_images WHERE id = ?').get('cp-1').body).state.output.content, 'fixed output');
});

test('stale checkpoint writers cannot overwrite the current head or leave orphan images', (t) => {
  const { database, store } = fixture(t).open();
  const other = new SqliteCheckpointStore(database);
  const saved = store.save(image(), 0);
  assert.throws(() => other.save(image('stale'), 0), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(database.prepare('SELECT count(*) AS count FROM checkpoint_images').get().count, 1);
  assert.deepEqual(store.read('context-1'), saved);
  assert.equal(other.save(image('cp-2'), 1).revision, 2);
  assert.throws(() => store.finish('context-1', 1, { status: 'succeeded', output: 'stale', progress: { round: 1, phase: 'receive', currentInput: {} } }), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(store.read('context-1').delivery, undefined);
});

test('duplicate checkpoint identities never replace an immutable body or advance a different scope', (t) => {
  const { database, store } = fixture(t).open();
  const saved = store.save(image(), 0);
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
    const saved = store.save(image(), 0);
    const next = image('cp-2');
    mutate(next);
    assert.throws(() => store.save(next, 1), { code: 'CHECKPOINT_CONFLICT' });
    assert.deepEqual(store.read('context-1'), saved);
  });
}

for (const delivery of [{ status: 'succeeded', output: { content: 'final delivery, not execute output' }, progress: { round: 2, phase: 'receive', currentInput: { final: true } } }, { status: 'failed' }, { status: 'cancelled' }]) {
  test(`checkpoint ${delivery.status} delivery is durable and closes further advancement`, (t) => {
    const disk = fixture(t);
    const first = disk.open();
    first.store.save(image(), 0);
    const finished = first.store.finish('context-1', 1, delivery);
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
  const saved = store.save(image(), 0);
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
  ...[1, 2, 3, 4].map((formatVersion) => [`unsupported format v${formatVersion}`, (database) => database.prepare('UPDATE checkpoint_images SET body = ?').run(JSON.stringify({ ...image(), formatVersion }))]),
  ['malformed image JSON', (database) => database.prepare('UPDATE checkpoint_images SET body = ?').run('{ broken')],
  ['image identity mismatch', (database) => database.prepare('UPDATE checkpoint_images SET body = ?').run(JSON.stringify(image('other-id')))],
  ['image context mismatch', (database) => database.prepare('UPDATE checkpoint_images SET context_id = ?').run('other-context')],
  ['invalid frame', (database) => database.prepare('UPDATE checkpoint_images SET body = ?').run(JSON.stringify({ ...image(), frame: {} }))],
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
    const reopened = disk.open();
    const code = label.startsWith('unsupported format') ? 'CHECKPOINT_FORMAT_UNSUPPORTED' : 'CHECKPOINT_STORAGE_FAILURE';
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
