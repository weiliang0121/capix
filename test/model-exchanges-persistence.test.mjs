import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { ModelExchanges, ModelExchangeViewSource, defaultModelExchangeLimits, maximumModelExchangeLimits } from '@weiliang0121/capix-model-exchanges';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';

const operation = (child) => ({ parentContextId: 'loop', childContextId: child, position: 'receive' });
const reply = () => ({ formatVersion: 1, id: 'reply', model: 'offline', output: [{ kind: 'tool-call', id: 'a', name: 'read', arguments: { encoding: 'json-text', text: '{}' } }], termination: { kind: 'completed', reason: 'tool_calls' }, native: { format: 'chat-completions', version: 1 }, usage: null });
const result = () => ({ status: 'ok', content: [{ kind: 'text', text: 'retained' }] });
const metadata = (content, limits = maximumModelExchangeLimits) => ({ source: { transcriptId: content.transcript.id, index: 0 }, scope: 'scope', policy: { version: 1 }, limits });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-exchange-store-'));
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
    sql(run) {
      const database = new DatabaseSync(path);
      try {
        return run(database);
      } finally {
        database.close();
      }
    },
  };
}

test('model exchanges initialize independently and survive reopen with exact feedback receipts and source version', (t) => {
  const files = fixture(t);
  const store = files.open();
  assert.equal(store.exchanges.load('unknown'), undefined);
  const entity = new ModelExchanges({ persistence: store.exchanges });
  assert.throws(() => store.exchanges.initialize(entity.snapshot(), metadata({ transcript: { id: 'missing' } })), { code: 'MODEL_EXCHANGE_PERSISTENCE_CONFLICT' });
  const content = loadConversationContent(store);
  store.exchanges.initialize(entity.snapshot(), metadata(content));
  store.exchanges.initialize(entity.snapshot(), metadata(content));
  assert.throws(() => store.exchanges.initialize(entity.snapshot(), { ...metadata(content), scope: 'other' }), { code: 'MODEL_EXCHANGE_PERSISTENCE_CONFLICT' });
  const initial = entity.intake('scope', operation('model'), reply());
  const final = entity.complete('scope', initial, 'a', result(), operation('tool'));
  const saved = entity.snapshot();
  assert.deepEqual(store.exchanges.load(entity.id), { state: saved, metadata: metadata(content) });
  const view = new ModelExchangeViewSource(entity, 'scope');
  const stamp = view.index().stamp;
  store.close();
  const reopened = files.open();
  const restored = ModelExchanges.restore(reopened.exchanges.load(entity.id).state, { persistence: reopened.exchanges });
  assert.deepEqual(restored.snapshot(), saved);
  assert.deepEqual(restored.complete('scope', initial, 'a', result(), operation('tool')), final);
  assert.equal(new ModelExchangeViewSource(restored, 'scope').check(stamp), true);
  assert.equal(reopened.load().transcript.id, content.transcript.id);
  assert.ok(Object.isFrozen(reopened.exchanges.load(entity.id).state.entries[0].feedback));
});

test('exchange CAS, duplicate effect and caller transition conflicts preserve store availability', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  let intake;
  const entity = new ModelExchanges({
    persistence: {
      commit(change) {
        intake = change;
        return store.exchanges.commit(change);
      },
    },
  });
  store.exchanges.initialize(entity.snapshot(), metadata(content));
  const ref = entity.intake('scope', operation('model'), reply());
  assert.throws(() => store.exchanges.commit(intake), { code: 'MODEL_EXCHANGE_PERSISTENCE_CONFLICT' });
  const forged = { ...intake, expectedSequence: 1, sequence: 2, entry: { ...intake.entry, id: 'other', sequence: 2 } };
  assert.throws(() => store.exchanges.commit(forged), { code: 'MODEL_EXCHANGE_PERSISTENCE_CONFLICT' });
  const invalidUpdate = { ...intake, expectedSequence: 1, sequence: 2, previous: intake.entry, entry: { ...intake.entry, scope: 'changed', revision: 1, feedback: [{ toolCallId: 'a', ...result() }] } };
  assert.throws(() => store.exchanges.commit(invalidUpdate), TypeError);
  entity.complete('scope', ref, 'a', result());
  store.assertAvailable();
  content.transcript.append({ role: 'user', content: 'still admitted' });
  assert.equal(store.load().transcript.messages.length, 1);
  assert.equal(store.exchanges.load(entity.id).state.sequence, 2);
});

for (const dimension of ['entries', 'bytes']) {
  test(`configured exchange ${dimension} above the default budget survive SQLite initialization, writes and reopen`, (t) => {
    const files = fixture(t);
    const store = files.open();
    const content = loadConversationContent(store);
    const active = new ModelExchanges({ limits: maximumModelExchangeLimits, persistence: store.exchanges });
    store.exchanges.initialize(active.snapshot(), metadata(content));
    const count = dimension === 'entries' ? defaultModelExchangeLimits.entries + 1 : 65;
    const incoming = reply();
    if (dimension === 'bytes') incoming.output.unshift({ kind: 'text', text: 'x'.repeat(1024 * 1024) });
    for (let i = 0; i < count; i++) active.intake('scope', operation(`initial-${i}`), incoming);
    const state = active.snapshot();
    if (dimension === 'bytes') assert.ok(Buffer.byteLength(JSON.stringify(state.entries)) > defaultModelExchangeLimits.bytes);
    const ref = active.intake('scope', operation('after-initialization'), reply());
    active.complete('scope', ref, 'a', result(), operation('after-initialization-tool'));
    const sequence = active.sequence;
    store.close();

    const reopened = files.open();
    const loaded = reopened.exchanges.load(active.id).state;
    assert.equal(loaded.entries.length, count + 1);
    assert.equal(loaded.sequence, sequence);
    const restored = ModelExchanges.restore(loaded, { limits: maximumModelExchangeLimits, persistence: reopened.exchanges });
    restored.intake('scope', operation('after-reopen'), reply());
    assert.equal(restored.sequence, sequence + 1);
    assert.deepEqual(restored.read('scope', ref, false).feedback, [{ toolCallId: 'a', ...result() }]);
    reopened.assertAvailable();
  });
}

test('exchange commit rolls back entry, effect index and collection metadata together', (t) => {
  const files = fixture(t);
  const initial = files.open();
  const content = loadConversationContent(initial);
  const empty = new ModelExchanges().snapshot();
  initial.exchanges.initialize(empty, metadata(content));
  initial.close();
  files.sql((database) => database.exec("CREATE TRIGGER reject_exchange_effect BEFORE INSERT ON model_exchange_operations BEGIN SELECT RAISE(ABORT, 'effect write failed'); END"));
  const store = files.open();
  const entity = ModelExchanges.restore(store.exchanges.load(empty.id).state, { persistence: store.exchanges });
  assert.throws(() => entity.intake('scope', operation('model'), reply()), PersistenceError);
  assert.equal(entity.sequence, 0);
  assert.throws(() => store.assertAvailable(), PersistenceError);
  store.close();
  const reopened = files.open();
  assert.deepEqual(reopened.exchanges.load(empty.id).state, empty);
});

test('damaged exchange effect indexes fail closed without fabricating another collection', (t) => {
  const files = fixture(t);
  const initial = files.open();
  const content = loadConversationContent(initial);
  const entity = new ModelExchanges({ persistence: initial.exchanges });
  initial.exchanges.initialize(entity.snapshot(), metadata(content));
  entity.intake('scope', operation('model'), reply());
  initial.close();
  files.sql((database) => database.exec('DELETE FROM model_exchange_operations'));
  const store = files.open();
  assert.throws(() => store.exchanges.load(entity.id), PersistenceError);
  assert.throws(() => store.assertAvailable(), PersistenceError);
});
