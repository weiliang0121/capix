import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync } from 'node:zlib';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { PersistenceError } from '@capix/diagnostics';

function image(id, contextId = 'root', input = { query: 'fixed' }) {
  return { id, formatVersion: 5, contract: { key: 'cache-fixture', version: 1 }, point: 'saved', frame: { owner: { contextId, kind: 'scene' }, round: 1, phase: 'execute', input, currentInput: input, nextChildOrder: 0, children: [] }, state: { text: 'material' }, references: {} };
}

function stored(value) {
  const bytes = Buffer.from(JSON.stringify(value));
  return JSON.stringify({ encoding: 'br', jsonBytes: bytes.length, data: brotliCompressSync(bytes).toString('base64') });
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-cp-cache-'));
  let connection;
  const prepare = DatabaseSync.prototype.prepare;
  // Capture the public native connection at construction for same-connection SQL
  // fault injection; no private service module or object field is accessed.
  const spy = t.mock.method(DatabaseSync.prototype, 'prepare', function (...args) {
    connection ??= this;
    return prepare.apply(this, args);
  });
  const store = ConversationStore.open(join(directory, 'conversation.sqlite'));
  spy.mock.restore();
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.ok(connection);
  return { store, database: connection, body: (id) => connection.prepare('SELECT body FROM checkpoint_images WHERE id = ?').get(id).body };
}

function countBodyReads(t, body) {
  let reads = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text, ...args) => {
    if (text === body) reads++;
    return parse(text, ...args);
  });
  return () => reads;
}

test('advancement reuses exact row evidence while public reads still decode the persisted body', (t) => {
  const f = fixture(t);
  f.store.checkpoints.save(image('first'), 0);
  const reads = countBodyReads(t, f.body('first'));
  const head = f.store.checkpoints.read('root');
  assert.equal(reads(), 1);
  assert.equal(f.store.checkpoints.listRoots().length, 1);
  assert.equal(reads(), 2);
  f.store.checkpoints.save(image('second'), 1);
  assert.equal(reads(), 2, 'save checks the real SQL row but reuses its certified advancement fields');
  assert.equal(head.image.id, 'first');
  assert.equal(f.body('first'), null);
  assert.equal(f.store.checkpoints.read('root').image.id, 'second');
});

for (const method of ['save', 'finish', 'read', 'listRoots']) {
  test(`same-revision body corruption is detected by ${method} after a cache was populated`, (t) => {
    const f = fixture(t);
    f.store.checkpoints.save(image('first'), 0);
    const payload = JSON.parse(f.body('first'));
    f.database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(JSON.stringify({ ...payload, data: 'AAAA' }), 'first');
    const call = method === 'save' ? () => f.store.checkpoints.save(image('second'), 1) : method === 'finish' ? () => f.store.checkpoints.finish('root', 1, { status: 'failed' }) : method === 'read' ? () => f.store.checkpoints.read('root') : () => f.store.checkpoints.listRoots();
    assert.throws(call, PersistenceError);
    assert.throws(() => f.store.assertAvailable(), PersistenceError);
  });
}

for (const [field, mutate] of [
  ['image context', (db) => db.exec("UPDATE checkpoint_images SET context_id = 'foreign'")],
  ['image revision', (db) => db.exec('UPDATE checkpoint_images SET revision = 2')],
  ['head revision', (db) => db.exec('UPDATE checkpoint_heads SET revision = 2')],
  ['missing current body', (db) => db.exec('UPDATE checkpoint_images SET body = NULL')],
  ['delivery without advancing revision', (db) => db.prepare('UPDATE checkpoint_heads SET delivery = ?').run(stored({ status: 'failed' }))],
]) {
  test(`cached advancement still checks ${field}`, (t) => {
    const f = fixture(t);
    f.store.checkpoints.save(image('first'), 0);
    mutate(f.database);
    assert.throws(() => f.store.checkpoints.save(image('second'), 1), PersistenceError);
  });
}

test('valid changed body at the same revision is decoded before comparing fixed input', (t) => {
  const f = fixture(t);
  f.store.checkpoints.save(image('first'), 0);
  f.database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(stored(image('first', 'root', { query: 'changed on disk' })), 'first');
  assert.throws(() => f.store.checkpoints.save(image('second'), 1), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(f.store.checkpoints.read('root').image.frame.input.query, 'changed on disk');
});

test('a cached head cannot adopt another scope image even at the same revision', (t) => {
  const f = fixture(t);
  f.store.checkpoints.save(image('first'), 0);
  f.store.checkpoints.save(image('foreign-image', 'foreign'), 0);
  f.database.exec("DELETE FROM checkpoint_heads WHERE context_id = 'foreign'");
  f.database.exec("UPDATE checkpoint_heads SET image_id = 'foreign-image' WHERE context_id = 'root'");
  assert.throws(() => f.store.checkpoints.finish('root', 1, { status: 'failed' }), PersistenceError);
});

test('write-time trigger changes cannot pair a changed SQL row with the original cached basis', (t) => {
  const f = fixture(t);
  const modified = stored(image('first', 'root', { query: 'trigger changed' }));
  f.database.exec(`CREATE TRIGGER mutate_saved_body AFTER INSERT ON checkpoint_images BEGIN UPDATE checkpoint_images SET body = '${modified}' WHERE id = NEW.id; END;`);
  f.store.checkpoints.save(image('first'), 0);
  f.database.exec('DROP TRIGGER mutate_saved_body');
  assert.throws(() => f.store.checkpoints.save(image('second'), 1), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(f.store.checkpoints.read('root').image.frame.input.query, 'trigger changed');
});

test('cache does not hide terminal delivery installed outside its write path', (t) => {
  const f = fixture(t);
  f.store.checkpoints.save(image('first'), 0);
  f.database.prepare('UPDATE checkpoint_heads SET revision = 2, delivery = ?').run(stored({ status: 'failed' }));
  assert.throws(() => f.store.checkpoints.save(image('second'), 2), { code: 'CHECKPOINT_CONFLICT', message: 'Final checkpoint delivery cannot advance' });
  assert.equal(f.store.checkpoints.read('root').delivery.status, 'failed');
});

test('failed CAS and rolled-back writes never install advancement evidence for an uncommitted image', (t) => {
  const f = fixture(t);
  f.store.checkpoints.save(image('first'), 0);
  assert.throws(() => f.store.checkpoints.save(image('stale'), 0), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(f.store.checkpoints.read('root').image.id, 'first');
  f.database.exec("CREATE TRIGGER reject_head BEFORE UPDATE ON checkpoint_heads BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END;");
  assert.throws(() => f.store.checkpoints.save(image('second'), 1), PersistenceError);
  assert.equal(f.database.prepare('SELECT image_id FROM checkpoint_heads').get().image_id, 'first');
  assert.equal(f.database.prepare("SELECT count(*) AS count FROM checkpoint_images WHERE id = 'second'").get().count, 0);
  assert.notEqual(f.body('first'), null);
  assert.throws(() => f.store.assertAvailable(), PersistenceError);
});

test('commit failure after the transaction callback preserves the preceding durable head', (t) => {
  const f = fixture(t);
  f.store.checkpoints.save(image('first'), 0);
  f.database.exec("CREATE TABLE commit_guard (reference TEXT REFERENCES checkpoint_images(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER reject_commit AFTER UPDATE ON checkpoint_heads BEGIN INSERT INTO commit_guard VALUES ('missing-image'); END;");
  assert.throws(() => f.store.checkpoints.save(image('second'), 1), PersistenceError);
  assert.equal(f.database.prepare('SELECT image_id FROM checkpoint_heads').get().image_id, 'first');
  assert.equal(f.database.prepare("SELECT count(*) AS count FROM checkpoint_images WHERE id = 'second'").get().count, 0);
  assert.equal(f.database.prepare('SELECT count(*) AS count FROM commit_guard').get().count, 0);
  assert.notEqual(f.body('first'), null);
  assert.throws(() => f.store.assertAvailable(), PersistenceError);
});

for (const input of [-0, { number: -0 }]) {
  test(`warm advancement preserves JSON signed-zero normalization (${typeof input})`, (t) => {
    const f = fixture(t);
    f.store.checkpoints.save(image('first', 'root', input), 0);
    const persisted = f.store.checkpoints.read('root');
    assert.equal(Object.is(typeof input === 'number' ? persisted.image.frame.input : persisted.image.frame.input.number, -0), false);
    assert.throws(() => f.store.checkpoints.save(image('second', 'root', input), 1), { code: 'CHECKPOINT_CONFLICT' });
    assert.equal(f.store.checkpoints.read('root').revision, 1);
  });
}

test('entry bound evicts least-recent advancement evidence without changing durable heads', (t) => {
  const f = fixture(t);
  f.store.checkpoints.save(image('old'), 0);
  const reads = countBodyReads(t, f.body('old'));
  for (let index = 0; index < 64; index++) f.store.checkpoints.save(image(`image-${index}`, `context-${index}`), 0);
  f.store.checkpoints.finish('root', 1, { status: 'failed' });
  assert.equal(reads(), 1, 'oldest entry is decoded after bounded evidence eviction');
  assert.equal(f.store.checkpoints.listRoots().length, 65);
});

test('byte bound evicts large basis material even below the entry-count limit', (t) => {
  const f = fixture(t);
  const input = { text: 'x'.repeat(2 * 1024 * 1024) };
  f.store.checkpoints.save(image('old', 'root', input), 0);
  const reads = countBodyReads(t, f.body('old'));
  for (let index = 0; index < 8; index++) f.store.checkpoints.save(image(`large-${index}`, `large-context-${index}`, input), 0);
  f.store.checkpoints.finish('root', 1, { status: 'failed' });
  assert.equal(reads(), 1);
});

test('finish releases evidence and terminal reads do not refill it', (t) => {
  const f = fixture(t);
  f.store.checkpoints.save(image('first'), 0);
  const reads = countBodyReads(t, f.body('first'));
  f.store.checkpoints.finish('root', 1, { status: 'failed' });
  assert.equal(reads(), 0);
  f.store.checkpoints.read('root');
  assert.equal(reads(), 1);
  assert.throws(() => f.store.checkpoints.finish('root', 2, { status: 'failed' }), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(reads(), 2);
});

test('closing a warm store invalidates its retained checkpoint port', (t) => {
  const f = fixture(t);
  const port = f.store.checkpoints;
  port.save(image('first'), 0);
  f.store.close();
  assert.equal(f.store.checkpoints, port);
  assert.throws(() => port.save(image('second'), 1), PersistenceError);
  assert.throws(() => port.finish('root', 1, { status: 'failed' }), PersistenceError);
  assert.throws(() => port.read('root'), PersistenceError);
  assert.doesNotThrow(() => f.store.close());
});
