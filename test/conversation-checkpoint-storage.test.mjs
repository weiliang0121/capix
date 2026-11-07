import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, brotliDecompressSync, constants } from 'node:zlib';
import { CHECKPOINT_MAX_BYTES } from '@capix/checkpoint';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { PersistenceError } from '@capix/diagnostics';
import { restoreLegacyCheckpointTables } from './fixtures/checkpoint-storage.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-cp-storage-'));
  const path = join(directory, 'conversation.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open() {
      const store = ConversationStore.open(path);
      stores.push(store);
      return store;
    },
    sql(work) {
      const database = new DatabaseSync(path);
      try {
        return work(database);
      } finally {
        database.close();
      }
    },
  };
}

function image(id = 'image-1', contextId = 'root', parentContextId) {
  return { id, formatVersion: 5, contract: { key: 'storage-fixture', version: 1 }, point: 'waiting', frame: { owner: { contextId, ...(parentContextId ? { parentContextId } : {}), kind: parentContextId ? 'node' : 'scene' }, round: 1, phase: 'execute', input: { text: 'question' }, currentInput: { text: 'question' }, nextChildOrder: 0, children: [] }, state: { text: 'saved state' }, references: {} };
}

// Build untrusted on-disk fixtures independently of the service's private encoding helpers.
function stored(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  return { encoding: 'br', jsonBytes: input.byteLength, data: brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }).toString('base64') };
}

function legacy(t) {
  const files = fixture(t);
  const initial = files.open();
  const content = loadConversationContent(initial);
  content.transcript.applyFixed({ contract: { key: 'transcript.append', version: 1 }, operation: { parentContextId: 'old-parent', childContextId: 'old-child', position: 'answer' }, transcriptId: content.transcript.id, messages: [{ role: 'user', content: '保留原文🙂' }] });
  content.memories.applyFixed({ contract: { key: 'memories.apply', version: 1 }, operation: { contextId: 'old-memory', position: 'apply' }, memoriesId: content.memories.id, changes: [] });
  const state = initial.load();
  initial.close();
  const first = image();
  first.state.text = '重复的材料与恢复依据🙂'.repeat(4000);
  const second = { ...first, id: 'image-2', point: 'completed' };
  const child = image('child-image', 'child', 'root');
  const delivery = { status: 'succeeded', output: { text: first.state.text }, progress: { round: 1, currentInput: first.frame.currentInput, phase: 'execute' } };
  files.sql((database) => {
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'archive_%'").all()) database.exec(`DROP TRIGGER ${row.name}`);
    database.exec('DROP TABLE archive_usage');
    restoreLegacyCheckpointTables(database);
    const insert = database.prepare('INSERT INTO checkpoint_images VALUES (?, ?, ?, ?)');
    insert.run(first.id, 'root', 1, JSON.stringify(first));
    insert.run(second.id, 'root', 2, JSON.stringify(second));
    insert.run(child.id, 'child', 1, JSON.stringify(child));
    database.prepare('INSERT INTO checkpoint_heads VALUES (?, ?, ?, ?)').run('root', 3, second.id, JSON.stringify(delivery));
    database.prepare('INSERT INTO checkpoint_heads VALUES (?, ?, ?, ?)').run('child', 1, child.id, null);
    database.exec('DROP TABLE model_exchange_operations; DROP TABLE model_exchange_entries; DROP TABLE model_exchanges; PRAGMA user_version = 2');
  });
  return { files, state, first, second, child, delivery };
}

function rows(database) {
  return {
    version: database.prepare('PRAGMA user_version').get().user_version,
    images: database.prepare('SELECT * FROM checkpoint_images ORDER BY rowid').all(),
    heads: database.prepare('SELECT * FROM checkpoint_heads ORDER BY rowid').all(),
    messages: database.prepare('SELECT * FROM messages ORDER BY position').all(),
    appends: database.prepare('SELECT * FROM append_receipts ORDER BY ordinal').all(),
    applies: database.prepare('SELECT * FROM apply_receipts ORDER BY ordinal').all(),
  };
}

test('v2 checkpoint storage migration preserves all image identities, current heads, terminal deliveries and content', (t) => {
  const { files, state, first, second, child, delivery } = legacy(t);
  const migrated = files.open();
  const root = { revision: 3, image: second, delivery };
  assert.deepEqual(migrated.load(), state);
  assert.deepEqual(migrated.checkpoints.read('root'), root);
  assert.deepEqual(migrated.checkpoints.read('child'), { revision: 1, image: child });
  assert.deepEqual(migrated.checkpoints.listRoots(), [root]);
  assert.throws(() => migrated.checkpoints.save(image(first.id, 'new-context'), 0), { code: 'CHECKPOINT_CONFLICT' });
  assert.equal(migrated.checkpoints.read('new-context'), undefined);
  assert.throws(() => migrated.checkpoints.finish('root', 3, { status: 'failed' }), { code: 'CHECKPOINT_CONFLICT' });
  migrated.assertAvailable();
  migrated.close();

  files.sql((database) => {
    const saved = rows(database);
    assert.equal(saved.version, 7);
    assert.deepEqual(
      saved.images.map(({ id, context_id, revision }) => ({ id, context_id, revision })),
      [
        { id: first.id, context_id: 'root', revision: 1 },
        { id: second.id, context_id: 'root', revision: 2 },
        { id: child.id, context_id: 'child', revision: 1 },
      ],
    );
    for (const [index, original] of [first, second, child].entries()) {
      if (original === first) {
        assert.equal(saved.images[index].body, null);
        continue;
      }
      const payload = JSON.parse(saved.images[index].body);
      assert.deepEqual(Object.keys(payload).sort(), ['data', 'encoding', 'jsonBytes']);
      assert.equal(payload.encoding, 'br');
      assert.equal(payload.jsonBytes, Buffer.byteLength(JSON.stringify(original), 'utf8'));
      assert.deepEqual(JSON.parse(brotliDecompressSync(Buffer.from(payload.data, 'base64')).toString('utf8')), original);
    }
    assert.equal(saved.heads[1].delivery, null);
    assert.equal(saved.appends.length, 1);
    assert.equal(saved.applies.length, 1);
  });
  const reopened = files.open();
  assert.deepEqual(reopened.checkpoints.read('root'), root);
  assert.deepEqual(reopened.load(), state);
});

for (const fault of ['image-write', 'delivery-write', 'historical-image-id-mismatch', 'historical-image-owner-mismatch']) {
  test(`v2 storage migration rolls back all converted rows and schema version on ${fault}`, (t) => {
    const { files } = legacy(t);
    files.sql((database) => {
      if (fault === 'image-write') database.exec("CREATE TRIGGER reject_migration BEFORE UPDATE OF body ON checkpoint_images WHEN OLD.id = 'image-2' BEGIN SELECT RAISE(ABORT, 'image fault'); END");
      else if (fault === 'delivery-write') database.exec("CREATE TRIGGER reject_migration BEFORE UPDATE OF delivery ON checkpoint_heads BEGIN SELECT RAISE(ABORT, 'delivery fault'); END");
      else if (fault === 'historical-image-id-mismatch') database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(JSON.stringify(image('wrong-id')), 'image-1');
      else database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?').run(JSON.stringify(image('image-1', 'wrong-context')), 'image-1');
    });
    const before = files.sql(rows);
    assert.throws(() => files.open(), PersistenceError);
    assert.deepEqual(files.sql(rows), before);
  });
}

test('v2 migration retains identities of opaque non-head Frames without certifying them for recovery', (t) => {
  const { files, state, first, second, delivery } = legacy(t);
  const past = { ...first, formatVersion: 4, historicalField: { noLongerInterpreted: true } };
  const future = { ...second, formatVersion: 6, futureField: ['unknown', { retained: true }] };
  const current = image('image-3');
  files.sql((database) => {
    const update = database.prepare('UPDATE checkpoint_images SET body = ? WHERE id = ?');
    update.run(JSON.stringify(past), past.id);
    update.run(JSON.stringify(future), future.id);
    database.prepare('INSERT INTO checkpoint_images VALUES (?, ?, ?, ?)').run(current.id, 'root', 3, JSON.stringify(current));
    database.prepare('UPDATE checkpoint_heads SET image_id = ?, revision = 4 WHERE context_id = ?').run(current.id, 'root');
  });
  const migrated = files.open();
  assert.deepEqual(migrated.load(), state);
  assert.deepEqual(migrated.checkpoints.read('root'), { revision: 4, image: current, delivery });
  assert.deepEqual(migrated.checkpoints.listRoots(), [{ revision: 4, image: current, delivery }]);
  for (const previous of [past, future]) assert.throws(() => migrated.checkpoints.save(image(previous.id, 'new-context'), 0), { code: 'CHECKPOINT_CONFLICT' });
  migrated.assertAvailable();
  migrated.close();
  files.sql((database) => {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 7);
    for (const expected of [past, future]) {
      assert.equal(database.prepare('SELECT body FROM checkpoint_images WHERE id = ?').get(expected.id).body, null);
    }
  });
});

test('v2 migration preserves opaque delivery data and leaves formal content readable while current recovery still rejects it', (t) => {
  const { files, state } = legacy(t);
  const opaque = { status: 'future-status', futureProgress: { step: 'opaque', values: [0, null, '保留🙂'] } };
  files.sql((database) => database.prepare('UPDATE checkpoint_heads SET delivery = ? WHERE context_id = ?').run(JSON.stringify(opaque), 'root'));
  const migrated = files.open();
  assert.deepEqual(migrated.load(), state);
  migrated.assertAvailable();
  migrated.close();
  files.sql((database) => {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 7);
    const payload = JSON.parse(database.prepare('SELECT delivery FROM checkpoint_heads WHERE context_id = ?').get('root').delivery);
    assert.deepEqual(JSON.parse(brotliDecompressSync(Buffer.from(payload.data, 'base64')).toString('utf8')), opaque);
  });
  const reopened = files.open();
  assert.deepEqual(reopened.load(), state);
  // Storage migration is not permission to recover unknown runtime contracts.
  assert.throws(() => reopened.checkpoints.read('root'), PersistenceError);
});

test('checkpoint storage compresses UTF-8 material and retains only the latest body without changing returned values', (t) => {
  const files = fixture(t);
  const store = files.open();
  loadConversationContent(store);
  const original = image();
  original.state = { text: '历史原文🙂'.repeat(16000), empty: null, numbers: [0, 1, -12.5], enabled: false };
  store.checkpoints.save(original, 0);
  const first = store.checkpoints.read('root');
  store.checkpoints.save({ ...original, id: 'image-2', point: 'completed' }, 1);
  const next = store.checkpoints.read('root');
  const delivery = { status: 'succeeded', output: { text: original.state.text }, progress: { round: 1, currentInput: original.frame.currentInput, phase: 'execute' } };
  store.checkpoints.finish('root', next.revision, delivery);
  const final = store.checkpoints.read('root');
  original.state.text = 'caller mutation';
  delivery.output.text = 'caller mutation';
  assert.notEqual(first.image.state.text, original.state.text);
  assert.notEqual(final.delivery.output.text, delivery.output.text);
  assert.ok(Object.isFrozen(final.image.state.numbers));
  store.close();

  files.sql((database) => {
    const saved = rows(database);
    assert.equal(saved.images.length, 2);
    assert.equal(saved.images[0].body, null);
    assert.equal(typeof saved.images[1].body, 'string');
    const rawBytes = Buffer.byteLength(JSON.stringify(first.image)) + Buffer.byteLength(JSON.stringify(next.image)) + Buffer.byteLength(JSON.stringify(final.delivery));
    const storedBytes = saved.images.reduce((total, row) => total + (row.body === null ? 0 : Buffer.byteLength(row.body)), 0) + Buffer.byteLength(saved.heads[0].delivery);
    assert.ok(storedBytes < rawBytes / 20, 'Repeated fixture material should reduce encoded SQL payload bytes, without claiming the same ratio for arbitrary data');
  });
  const reopened = files.open();
  assert.deepEqual(reopened.checkpoints.read('root'), final);
  assert.deepEqual(reopened.checkpoints.listRoots(), [final]);
});

const invalidBodies = [
  ['unsupported encoding', () => ({ ...stored(JSON.stringify(image())), encoding: 'gzip' })],
  ['unexpected envelope field', () => ({ ...stored(JSON.stringify(image())), parentContextId: null })],
  ['noncanonical base64', () => ({ ...stored(JSON.stringify(image())), data: 'YQ===' })],
  [
    'ignored base64 whitespace',
    () => {
      const payload = stored(JSON.stringify(image()));
      return { ...payload, data: payload.data + '\n   ' };
    },
  ],
  ['corrupt compressed input', () => ({ encoding: 'br', jsonBytes: 100, data: 'AAAA' })],
  ['uncompressed size over limit', () => ({ ...stored(JSON.stringify(image())), jsonBytes: CHECKPOINT_MAX_BYTES + 1 })],
  ['declared size too short', () => ({ ...stored(JSON.stringify(image())), jsonBytes: 10 })],
  [
    'declared size too long',
    () => {
      const payload = stored(JSON.stringify(image()));
      return { ...payload, jsonBytes: payload.jsonBytes + 1 };
    },
  ],
  ['compressed expansion beyond limit', () => ({ ...stored(' '.repeat(CHECKPOINT_MAX_BYTES + 1)), jsonBytes: CHECKPOINT_MAX_BYTES })],
  ['invalid UTF-8', () => stored(Buffer.from([0x22, 0xff, 0x22]))],
  ['invalid JSON', () => stored('not-json')],
  ['invalid Frame', () => stored(JSON.stringify({ ...image(), formatVersion: 4 }))],
  ['image identity mismatch', () => stored(JSON.stringify(image('different-image')))],
  ['context identity mismatch', () => stored(JSON.stringify(image('image-1', 'different-context')))],
];

for (const [name, create] of invalidBodies) {
  test(`invalid compressed checkpoint ${name} fails closed through the public store`, (t) => {
    const files = fixture(t);
    const initial = files.open();
    loadConversationContent(initial);
    initial.checkpoints.save(image(), 0);
    initial.close();
    files.sql((database) => database.prepare('UPDATE checkpoint_images SET body = ?').run(JSON.stringify(create())));
    const reopened = files.open();
    assert.throws(() => reopened.checkpoints.read('root'), PersistenceError);
    assert.throws(() => reopened.assertAvailable(), PersistenceError);
  });
}

test('listRoots validates child heads too instead of hiding damaged children behind a root-only SQL projection', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  initial.checkpoints.save(image(), 0);
  const root = initial.checkpoints.read('root');
  initial.checkpoints.save(image('child-image', 'child', 'root'), 0);
  initial.close();
  files.sql((database) => database.prepare('UPDATE checkpoint_images SET body = ? WHERE context_id = ?').run(JSON.stringify({ encoding: 'br', jsonBytes: 100, data: 'AAAA' }), 'child'));
  const reopened = files.open();
  assert.deepEqual(reopened.checkpoints.read('root'), root);
  assert.throws(() => reopened.checkpoints.listRoots(), PersistenceError);
  assert.throws(() => reopened.assertAvailable(), PersistenceError);
});

test('damaged compressed terminal delivery is not ignored or converted into a resumable head', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  initial.checkpoints.save(image(), 0);
  initial.checkpoints.finish('root', 1, { status: 'failed' });
  initial.close();
  files.sql((database) => database.prepare('UPDATE checkpoint_heads SET delivery = ?').run(JSON.stringify(stored('{"status":"unknown"}'))));
  const reopened = files.open();
  assert.throws(() => reopened.checkpoints.listRoots(), PersistenceError);
  assert.throws(() => reopened.assertAvailable(), PersistenceError);
});
