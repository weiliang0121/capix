import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { brotliCompressSync, constants } from 'node:zlib';
import { CHECKPOINT_MAX_BYTES } from '@capix/checkpoint';
import { encodeCheckpointRecord, decodeCheckpointRecord } from '@capix/checkpoint/storage';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { PersistenceError } from '@capix/diagnostics';

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
  return { id, formatVersion: 6, contract: { key: 'storage-fixture', version: 1 }, point: 'waiting', frame: { owner: { contextId, ...(parentContextId ? { parentContextId } : {}), kind: parentContextId ? 'node' : 'scene' }, round: 1, phase: 'execute', input: { text: 'question' }, currentInput: { text: 'question' }, nextChildOrder: 0, children: [] }, state: { text: 'saved state' }, references: {} };
}

// Build untrusted on-disk fixtures independently of the service's private encoding helpers.
function stored(bytes) {
  const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  return { encoding: 'br', jsonBytes: input.byteLength, data: brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } }).toString('base64') };
}

function rows(database) {
  return {
    version: database.prepare('PRAGMA user_version').get().user_version,
    images: database.prepare('SELECT * FROM checkpoint_images ORDER BY rowid').all(),
    heads: database.prepare('SELECT * FROM checkpoint_heads ORDER BY rowid').all(),
    values: database.prepare('SELECT metadata,body FROM checkpoint_values ORDER BY id').all(),
  };
}

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
    const storedBytes = saved.images.reduce((total, row) => total + (row.body === null ? 0 : Buffer.byteLength(row.body)), 0) + saved.values.reduce((total, row) => total + Buffer.byteLength(row.metadata) + (row.body === null ? 0 : Buffer.byteLength(row.body)), 0) + Buffer.byteLength(saved.heads[0].delivery);
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
  ['unsupported value encoding', () => stored('{"format":"unknown","value":null}')],
  ['changed value without matching digest', () => stored('{"format":"capix.checkpoint.value@1","value":"different"}')],
];

for (const [name, create] of invalidBodies) {
  test(`invalid compressed checkpoint value ${name} fails closed through the public store`, (t) => {
    const files = fixture(t);
    const initial = files.open();
    loadConversationContent(initial);
    initial.checkpoints.save(image(), 0);
    initial.close();
    files.sql((database) => database.prepare('UPDATE checkpoint_values SET body = ? WHERE body IS NOT NULL').run(JSON.stringify(create())));
    const reopened = files.open();
    assert.throws(() => reopened.checkpoints.read('root'), PersistenceError);
    assert.throws(() => reopened.assertAvailable(), PersistenceError);
  });
}

for (const [name, mutate] of [
  ['image identity', (head) => (head.commit.id = 'different-image')],
  ['owner identity', (head) => (head.commit.frame.owner.contextId = 'different-context')],
  ['Frame version', (head) => (head.commit.formatVersion = 5)],
]) {
  test(`incremental head ${name} corruption is not accepted as current state`, (t) => {
    const files = fixture(t);
    const initial = files.open();
    loadConversationContent(initial);
    initial.checkpoints.save(image(), 0);
    initial.close();
    files.sql((database) => {
      const head = structuredClone(decodeCheckpointRecord('head', database.prepare('SELECT body FROM checkpoint_images').get().body));
      mutate(head);
      database.prepare('UPDATE checkpoint_images SET body = ?').run(encodeCheckpointRecord('head', head));
    });
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
