import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { CompletionInteraction } from '@capix/conversation-service';
import { Interaction } from '@capix/interaction';
import { ModelExchanges } from '@capix/model-exchanges';
import { PersistenceError } from '@capix/diagnostics';
import { restoreLegacyCheckpointTables } from './fixtures/checkpoint-storage.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const operation = (child = 'model') => ({ parentContextId: 'loop', childContextId: child, position: 'receive' });
const reply = (text = '你好🙂') => ({ formatVersion: 1, id: 'reply', model: 'offline', output: [{ kind: 'text', text }], termination: { kind: 'completed', reason: 'stop' }, native: { format: 'chat-completions', version: 1 }, usage: null });
const metadata = (content, scope = 'scope') => ({ source: { transcriptId: content.transcript.id, index: 0 }, scope, policy: { version: 'fixture-v1', catalog: 'fixed' }, limits: { entries: 128, bytes: 8 * 1024 * 1024 } });
const image = (id = 'cp1') => ({ id, formatVersion: 5, contract: { key: 'archive-fixture', version: 1 }, point: 'waiting', frame: { owner: { contextId: 'root', kind: 'scene' }, round: 1, phase: 'execute', input: {}, currentInput: {}, nextChildOrder: 0, children: [] }, state: { repeated: '材料'.repeat(1024) }, references: {} });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-archive-'));
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

test('collections have independent effects and sequences; paginated directory and exact load do not hydrate unrelated bodies', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  const a = new ModelExchanges({ persistence: store.exchanges });
  const b = new ModelExchanges({ persistence: store.exchanges });
  store.exchanges.initialize(a.snapshot(), metadata(content, 'a'));
  store.exchanges.initialize(b.snapshot(), metadata(content, 'b'));
  // The same operation value belongs to two independent entities, not a global index.
  a.intake('a', operation(), reply('A'));
  b.intake('b', operation(), reply('B'));
  const first = store.exchanges.list({ limit: 1 });
  const second = store.exchanges.list({ after: first.next, limit: 1 });
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.equal(second.next, undefined);
  assert.deepEqual(
    [...first.items, ...second.items].map((item) => item.id),
    [a.id, b.id].sort(),
  );
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['bytes', 'entries', 'id', 'metadata', 'sequence']);
  assert.ok(Object.isFrozen(first.items[0].metadata.policy));
  assert.throws(() => store.exchanges.list({ limit: 201 }), RangeError);
  assert.throws(() => store.exchanges.load(), TypeError);
  store.assertAvailable();
  store.close();

  files.sql((database) => database.prepare('UPDATE model_exchange_entries SET body = ? WHERE collection = ?').run('{"damaged":true}', a.id));
  const reopened = files.open();
  assert.equal(reopened.load().transcript.id, content.transcript.id);
  assert.equal(reopened.exchanges.list().items.length, 2);
  assert.deepEqual(reopened.exchanges.load(b.id).state, b.snapshot());
  assert.throws(() => reopened.exchanges.load(a.id), PersistenceError);
});

test('prepared initialization confirms only the exact empty plan and never overwrites progressed facts', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  const entity = new ModelExchanges({ persistence: store.exchanges });
  const empty = entity.snapshot();
  const fixed = metadata(content);
  store.exchanges.initialize(empty, fixed);
  const initialUsage = store.archiveUsage();
  store.exchanges.initialize(structuredClone(empty), structuredClone(fixed));
  assert.deepEqual(store.archiveUsage(), initialUsage);
  for (const changed of [
    { ...fixed, scope: 'other' },
    { ...fixed, source: { ...fixed.source, index: 1 } },
    { ...fixed, policy: { version: 'different' } },
    { ...fixed, limits: { entries: 2, bytes: fixed.limits.bytes } },
  ]) {
    assert.throws(() => store.exchanges.initialize(empty, changed), { code: 'MODEL_EXCHANGE_PERSISTENCE_CONFLICT' });
  }
  let observed = false;
  const unsafe = Object.defineProperty({}, 'source', {
    enumerable: true,
    get() {
      observed = true;
      return fixed.source;
    },
  });
  assert.throws(() => store.exchanges.initialize(empty, unsafe));
  assert.equal(observed, false);
  entity.intake('scope', operation(), reply());
  assert.throws(() => store.exchanges.initialize(empty, fixed), { code: 'MODEL_EXCHANGE_PERSISTENCE_CONFLICT' });
  assert.throws(() => store.exchanges.initialize(entity.snapshot(), fixed), TypeError);
  assert.deepEqual(store.exchanges.load(entity.id).state, entity.snapshot());
  store.assertAvailable();
});

test('fixed collection limits and source are checked independently of the host admission gate', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  const entity = new ModelExchanges({ persistence: store.exchanges });
  const fixed = { ...metadata(content), limits: { entries: 1, bytes: 2048 } };
  assert.throws(() => store.exchanges.initialize(entity.snapshot(), { ...fixed, source: { transcriptId: 'another-conversation', index: 0 } }), { code: 'MODEL_EXCHANGE_PERSISTENCE_CONFLICT' });
  store.exchanges.initialize(entity.snapshot(), fixed);
  entity.intake('scope', operation(), reply());
  const previous = store.archiveUsage();
  // A caller using broader entity limits cannot override the persisted collection contract.
  assert.throws(() => entity.intake('scope', operation('second'), reply()), PersistenceError);
  assert.deepEqual(store.archiveUsage(), previous);
  assert.equal(store.exchanges.load(entity.id).state.sequence, 1);
  store.assertAvailable();
});

test('joint usage counts retained JSON, current CP bodies and late feedback; it does not reserve or reject commits', async (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  assert.deepEqual(store.archiveUsage(), { exchangesBytes: 0, interactionsBytes: 0, checkpointBytes: 0, totalBytes: 0 });
  const entity = new ModelExchanges({ persistence: store.exchanges });
  const fixed = metadata(content);
  store.exchanges.initialize(entity.snapshot(), fixed);
  const tools = reply();
  tools.output = [{ kind: 'tool-call', id: 'call', name: 'read', arguments: { encoding: 'json-text', text: '{}' } }];
  tools.termination.reason = 'tool_calls';
  const ref = entity.intake('scope', operation(), tools);
  entity.complete('scope', ref, 'call', { status: 'ok', content: [{ kind: 'text', text: '工具结果🙂' }] });
  const exchangeBytes = bytes(fixed) + bytes(entity.snapshot().entries[0]);
  assert.equal(store.archiveUsage().exchangesBytes, exchangeBytes);

  let finish;
  const external = new Promise((resolve) => {
    finish = resolve;
  });
  const interaction = new Interaction({ messages: [{ role: 'user', content: '固定请求' }] }, { contract: CompletionInteraction, persistence: store.interactions });
  assert.equal(store.archiveUsage().interactionsBytes, bytes(interaction.exportState()));
  interaction.start(() => external);
  const startedBytes = bytes(interaction.exportState());
  assert.equal(store.archiveUsage().interactionsBytes, startedBytes);

  const first = image();
  const next = image('cp2');
  const delivery = { status: 'succeeded', output: '正式回答', progress: { round: 1, currentInput: {}, phase: 'execute' } };
  store.checkpoints.save(first, 0);
  store.checkpoints.save(next, 1);
  store.checkpoints.finish('root', 2, delivery);
  const checkpointBytes = bytes(next) + bytes(delivery);
  const beforeFeedback = store.archiveUsage();
  assert.equal(beforeFeedback.checkpointBytes, checkpointBytes);
  assert.equal(beforeFeedback.totalBytes, exchangeBytes + startedBytes + checkpointBytes);
  // An entry gate may now refuse another run. The original sender can still save.
  finish(reply('晚到反馈'));
  await interaction.settled();
  const interactionBytes = bytes(interaction.exportState());
  const finalUsage = store.archiveUsage();
  assert.equal(finalUsage.interactionsBytes, interactionBytes);
  assert.equal(finalUsage.totalBytes, exchangeBytes + interactionBytes + checkpointBytes);
  assert.ok(finalUsage.totalBytes > beforeFeedback.totalBytes);
  assert.ok(Object.isFrozen(finalUsage));
  store.close();
  const reopened = files.open();
  assert.deepEqual(reopened.archiveUsage(), finalUsage);
});

test('archive counters roll back with a failed CP commit and retain the prior usage after reopening', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  const before = initial.archiveUsage();
  initial.close();
  files.sql((database) => database.exec("CREATE TRIGGER reject_archive_head BEFORE INSERT ON checkpoint_heads BEGIN SELECT RAISE(ABORT, 'head failure'); END"));
  const store = files.open();
  assert.throws(() => store.checkpoints.save(image(), 0), PersistenceError);
  assert.throws(() => store.archiveUsage(), PersistenceError);
  store.close();
  const reopened = files.open();
  assert.deepEqual(reopened.archiveUsage(), before);
  assert.equal(reopened.checkpoints.read('root'), undefined);
});

test('v4 collection migrates intact as unanchored read-only data beside new independently writable collections', async (t) => {
  const files = fixture(t);
  const initial = files.open();
  const content = loadConversationContent(initial);
  content.transcript.append({ role: 'user', content: 'original' });
  initial.checkpoints.save(image(), 0);
  const interaction = new Interaction({ messages: [{ role: 'user', content: 'original' }] }, { contract: CompletionInteraction, persistence: initial.interactions });
  interaction.start(() => reply());
  await interaction.settled();
  initial.close();
  const old = new ModelExchanges();
  old.intake('old-scope', operation(), reply('old exchange'));
  const state = old.snapshot();
  const preserved = files.sql((database) => {
    restoreLegacyCheckpointTables(database);
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'archive_%'").all()) database.exec(`DROP TRIGGER ${row.name}`);
    database.exec(`DROP TABLE archive_usage; DROP TABLE model_exchange_operations; DROP TABLE model_exchange_entries; DROP TABLE model_exchanges;
      CREATE TABLE model_exchanges (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, sequence INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT;
      CREATE TABLE model_exchange_entries (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, revision INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
      CREATE TABLE model_exchange_operations (operation TEXT PRIMARY KEY, exchange_id TEXT NOT NULL REFERENCES model_exchange_entries(id), call_id TEXT) STRICT;
      PRAGMA user_version = 4;`);
    database.prepare('INSERT INTO model_exchanges VALUES (1, ?, ?, ?)').run(state.id, state.sequence, bytes(state.entries[0]));
    const entry = state.entries[0];
    database.prepare('INSERT INTO model_exchange_entries VALUES (?, ?, ?, ?)').run(entry.id, entry.sequence, entry.revision, JSON.stringify(entry));
    database.prepare('INSERT INTO model_exchange_operations VALUES (?, ?, NULL)').run(JSON.stringify([entry.operation.parentContextId, entry.operation.childContextId, entry.operation.position]), entry.id);
    return { images: database.prepare('SELECT * FROM checkpoint_images').all(), heads: database.prepare('SELECT * FROM checkpoint_heads').all(), interactions: database.prepare('SELECT * FROM completion_interactions').all(), entries: database.prepare('SELECT * FROM model_exchange_entries').all() };
  });
  const migrated = files.open();
  assert.deepEqual(migrated.exchanges.load(state.id), { state, metadata: null });
  assert.equal(migrated.exchanges.list().items[0].metadata, null);
  const continued = ModelExchanges.restore(state, { persistence: migrated.exchanges });
  assert.throws(() => continued.intake('old-scope', operation('new-model'), reply('new')), PersistenceError);
  assert.equal(continued.sequence, state.sequence);
  migrated.assertAvailable();
  const fresh = new ModelExchanges({ persistence: migrated.exchanges });
  migrated.exchanges.initialize(fresh.snapshot(), metadata(content));
  fresh.intake('scope', operation(), reply('fresh'));
  assert.equal(migrated.exchanges.list().items.length, 2);
  assert.ok(migrated.archiveUsage().interactionsBytes > 0);
  assert.ok(migrated.archiveUsage().checkpointBytes > 0);
  migrated.close();
  files.sql((database) => {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 6);
    assert.deepEqual(database.prepare('SELECT * FROM checkpoint_images').all(), preserved.images);
    assert.deepEqual(database.prepare('SELECT * FROM checkpoint_heads').all(), preserved.heads);
    assert.deepEqual(database.prepare('SELECT * FROM completion_interactions').all(), preserved.interactions);
    assert.deepEqual(database.prepare('SELECT id, ordinal, revision, body FROM model_exchange_entries WHERE collection = ?').all(state.id), preserved.entries);
  });
});

test('missing archive accounting cannot silently reopen with stale usage', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  initial.close();
  files.sql((database) => database.exec('DROP TRIGGER archive_completion_interactions_update'));
  const before = readFileSync(files.path);
  assert.throws(() => ConversationStore.open(files.path), PersistenceError);
  assert.deepEqual(readFileSync(files.path), before);
});

test('failure while installing v5 accounting rolls the collection migration back completely', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  initial.close();
  files.sql((database) => {
    restoreLegacyCheckpointTables(database);
    for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'archive_%'").all()) database.exec(`DROP TRIGGER ${row.name}`);
    database.exec(`DROP TABLE archive_usage; DROP TABLE model_exchange_operations; DROP TABLE model_exchange_entries; DROP TABLE model_exchanges;
      CREATE TABLE model_exchanges (singleton INTEGER PRIMARY KEY CHECK(singleton=1), id TEXT NOT NULL, sequence INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT;
      CREATE TABLE model_exchange_entries (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, revision INTEGER NOT NULL, body TEXT NOT NULL) STRICT;
      CREATE TABLE model_exchange_operations (operation TEXT PRIMARY KEY, exchange_id TEXT NOT NULL REFERENCES model_exchange_entries(id), call_id TEXT) STRICT;
      INSERT INTO model_exchanges VALUES (1, 'retained-v4-id', 0, 0);
      CREATE TRIGGER archive_completion_interactions_insert AFTER INSERT ON completion_interactions BEGIN SELECT 1; END;
      PRAGMA user_version = 4;`);
  });
  assert.throws(() => ConversationStore.open(files.path), PersistenceError);
  files.sql((database) => {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 4);
    assert.deepEqual(database.prepare('SELECT * FROM model_exchanges').get(), { __proto__: null, singleton: 1, id: 'retained-v4-id', sequence: 0, bytes: 0 });
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'archive_usage'").get(), undefined);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'old_model_exchanges'").get(), undefined);
  });
});

test('a missing collection with orphaned entry rows is not initialized as a new empty collection', (t) => {
  const files = fixture(t);
  const initial = files.open();
  const content = loadConversationContent(initial);
  const entity = new ModelExchanges({ persistence: initial.exchanges });
  const empty = entity.snapshot();
  initial.exchanges.initialize(empty, metadata(content));
  entity.intake('scope', operation(), reply());
  initial.close();
  files.sql((database) => {
    database.exec('PRAGMA foreign_keys = OFF');
    database.prepare('DELETE FROM model_exchanges WHERE id = ?').run(entity.id);
  });
  const reopened = files.open();
  assert.throws(() => reopened.exchanges.initialize(empty, metadata(content)), PersistenceError);
  assert.throws(() => reopened.assertAvailable(), PersistenceError);
});
