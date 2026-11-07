import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { CompletionInteraction } from '@capix/conversation-service';
import { Interaction } from '@capix/interaction';
import { PersistenceError } from '@capix/diagnostics';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-recovery-store-'));
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
  };
}

function image(id = 'image-1', contextId = 'root') {
  return { id, formatVersion: 6, contract: { key: 'conversation.test', version: 1 }, point: 'waiting', frame: { owner: { contextId, kind: 'scene' }, round: 1, phase: 'execute', input: { text: 'question' }, currentInput: { text: 'question' }, nextChildOrder: 0, children: [] }, state: { step: 'answer' }, references: {} };
}

function reply(text = 'answer') {
  return { id: 'reply', model: 'offline', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null };
}

test('checkpoint images and delivery survive reopen, retain detached frozen values and distinguish roots', (t) => {
  const files = fixture(t);
  const store = files.open();
  loadConversationContent(store);
  const original = image();
  const saved = store.checkpoints.save(original, 0);
  const first = store.checkpoints.read('root');
  assert.equal(saved.kind, 'saved');
  assert.equal(saved.contextId, 'root');
  assert.equal(saved.checkpointId, 'image-1');
  assert.equal(saved.revision, first.revision);
  assert.equal('image' in saved, false);
  original.state.step = 'mutated';
  const child = image('child-image', 'child');
  child.frame.owner = { contextId: 'child', parentContextId: 'root', kind: 'node' };
  store.checkpoints.save(child, 0);
  assert.deepEqual(store.checkpoints.listRoots(), [first]);
  assert.equal(store.checkpoints.read('root').image.state.step, 'answer');
  assert.ok(Object.isFrozen(first.image.state));
  const next = store.checkpoints.save({ ...image('image-2'), point: 'answered' }, 1);
  assert.equal(next.revision, 2);
  const output = { answer: 'final' };
  const finished = store.checkpoints.finish('root', 2, { status: 'succeeded', output, progress: { round: 1, currentInput: {}, phase: 'execute' } });
  const final = store.checkpoints.read('root');
  assert.equal(finished.kind, 'finished');
  assert.equal(finished.contextId, 'root');
  assert.equal(finished.checkpointId, 'image-2');
  assert.equal(finished.revision, final.revision);
  assert.equal(finished.status, 'succeeded');
  assert.equal('delivery' in finished, false);
  output.answer = 'changed';
  assert.equal(final.delivery.output.answer, 'final');
  store.close();

  const reopened = files.open();
  assert.deepEqual(reopened.checkpoints.read('root'), final);
  assert.deepEqual(reopened.checkpoints.listRoots(), [final]);
  assert.equal(reopened.checkpoints.read('child').image.frame.owner.parentContextId, 'root');
  assert.equal(reopened.checkpoints.read('missing'), undefined);
});

test('checkpoint CAS, original identity/input, duplicate image and finality conflicts do not poison content', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  store.checkpoints.save(image(), 0);
  const conflict = { code: 'CHECKPOINT_CONFLICT' };
  assert.throws(() => store.checkpoints.save(image('next'), 0), conflict);
  assert.throws(() => store.checkpoints.save(image(), 1), conflict);
  assert.throws(() => store.checkpoints.save(image('image-1', 'another'), 0), conflict);
  for (const mutate of [(next) => (next.frame.owner.kind = 'group'), (next) => (next.frame.owner.parentContextId = 'parent'), (next) => (next.frame.input = 'changed'), (next) => (next.contract.version = 2)]) {
    const next = image('next');
    mutate(next);
    assert.throws(() => store.checkpoints.save(next, 1), conflict);
  }
  store.checkpoints.finish('root', 1, { status: 'failed' });
  assert.throws(() => store.checkpoints.save(image('next'), 2), conflict);
  assert.throws(() => store.checkpoints.finish('root', 2, { status: 'cancelled' }), conflict);
  assert.throws(() => store.checkpoints.finish('missing', 0, { status: 'failed' }), conflict);
  store.assertAvailable();
  content.transcript.append({ role: 'user', content: 'subsequent input' });
  assert.equal(store.load().transcript.messages.length, 1);
});

test('oversize or invalid caller checkpoint values do not create heads or close admission', (t) => {
  const files = fixture(t);
  const store = files.open();
  loadConversationContent(store);
  assert.throws(() => store.checkpoints.save({ ...image(), state: 'x'.repeat(8 * 1024 * 1024) }, 0), /byte limit/);
  assert.throws(() => store.checkpoints.save(image(), -1), TypeError);
  assert.throws(() => store.checkpoints.save({ ...image(), formatVersion: 4 }, 0), { code: 'CHECKPOINT_FORMAT_UNSUPPORTED' });
  assert.deepEqual(store.checkpoints.listRoots(), []);
  store.assertAvailable();
});

test('checkpoint write failure rolls back image/head together and closes admission', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  initial.close();
  const database = new DatabaseSync(files.path);
  database.exec("CREATE TRIGGER reject_head BEFORE INSERT ON checkpoint_heads BEGIN SELECT RAISE(ABORT, 'disk fault'); END;");
  database.close();
  const store = files.open();
  assert.throws(() => store.checkpoints.save(image(), 0), PersistenceError);
  assert.throws(() => store.assertAvailable(), PersistenceError);
  store.close();
  const reopened = files.open();
  assert.deepEqual(reopened.checkpoints.listRoots(), []);
  assert.equal(reopened.checkpoints.read('root'), undefined);
  assert.equal(reopened.load().transcript.messages.length, 0);
});

test('closing a current store invalidates its retained checkpoint port', (t) => {
  const files = fixture(t);
  const store = files.open();
  loadConversationContent(store);
  const port = store.checkpoints;
  port.save(image(), 0);
  store.close();
  assert.equal(store.checkpoints, port);
  assert.throws(() => port.save(image('next'), 1), PersistenceError);
  assert.throws(() => port.finish('root', 1, { status: 'failed' }), PersistenceError);
  assert.throws(() => port.read('root'), PersistenceError);
  assert.doesNotThrow(() => store.close());
  assert.equal(files.open().checkpoints.read('root').image.id, 'image-1');
});

test('stored checkpoint corruption is a persistence failure, not a missing or resumable root', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  initial.checkpoints.save(image(), 0);
  initial.close();
  const database = new DatabaseSync(files.path);
  database.exec('UPDATE checkpoint_heads SET revision = 8');
  database.close();
  const store = files.open();
  assert.throws(() => store.checkpoints.listRoots(), PersistenceError);
  assert.throws(() => store.assertAvailable(), PersistenceError);
});

test('completion request and full feedback reopen read-only without re-sending or persisting preview', async (t) => {
  const files = fixture(t);
  const store = files.open();
  loadConversationContent(store);
  const interaction = new Interaction({ messages: [{ role: 'user', content: 'question' }], stream: true }, { contract: CompletionInteraction, persistence: store.interactions });
  let sent = 0;
  interaction.start(async () => {
    sent++;
    return reply();
  });
  await interaction.settled();
  const saved = store.interactions.read(interaction.id);
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved.feedback.payload, reply());
  assert.ok(Object.isFrozen(saved.request.messages));
  store.close();
  const reopened = files.open();
  const restored = Interaction.restore(reopened.interactions.read(interaction.id), { contract: CompletionInteraction });
  assert.equal(restored.read().kind, 'received');
  assert.deepEqual(restored.read().feedback.payload, reply());
  assert.throws(
    () =>
      restored.start(() => {
        sent++;
        return reply();
      }),
    { code: 'INTERACTION_RESTORED' },
  );
  assert.equal(sent, 1);
  assert.equal(reopened.interactions.read('missing'), undefined);
});

test('persisted started interaction with no reply remains unavailable after restart', (t) => {
  const files = fixture(t);
  const store = files.open();
  loadConversationContent(store);
  const prepared = { id: 'in-flight', contract: CompletionInteraction.key, revision: 0, delivery: 'prepared', request: { messages: [{ role: 'user', content: 'question' }] } };
  store.interactions.create(prepared);
  store.interactions.commit({ expectedRevision: 0, state: { ...prepared, revision: 1, delivery: 'started' } });
  store.close();
  const restored = Interaction.restore(files.open().interactions.read(prepared.id), { contract: CompletionInteraction });
  assert.equal(restored.read().kind, 'unavailable');
  assert.equal(restored.read().error.code, 'INTERACTION_RESTORED_PENDING');
});

test('interaction CAS and immutable request/feedback conflicts preserve content availability', (t) => {
  const files = fixture(t);
  const store = files.open();
  const content = loadConversationContent(store);
  const prepared = { id: 'request', contract: CompletionInteraction.key, revision: 0, delivery: 'prepared', request: { messages: [{ role: 'user', content: 'question' }] } };
  const started = { ...prepared, delivery: 'started', revision: 1 };
  const finished = { ...started, revision: 2, feedback: { id: 'feedback', payload: reply() } };
  const conflict = { code: 'INTERACTION_PERSISTENCE_CONFLICT' };
  store.interactions.create(prepared);
  assert.throws(() => store.interactions.create(prepared), conflict);
  store.interactions.commit({ expectedRevision: 0, state: started });
  assert.throws(() => store.interactions.commit({ expectedRevision: 0, state: started }), conflict);
  assert.throws(() => store.interactions.commit({ expectedRevision: 1, state: { ...finished, request: { messages: [{ role: 'user', content: 'replacement' }] } } }), conflict);
  store.interactions.commit({ expectedRevision: 1, state: finished });
  assert.throws(() => store.interactions.commit({ expectedRevision: 2, state: { ...finished, revision: 3, feedback: { id: 'other', payload: reply('changed') }, failure: { code: 'FAILURE', message: 'later' } } }), conflict);
  assert.deepEqual(store.interactions.read(prepared.id), finished);
  content.transcript.append({ role: 'user', content: 'still available' });
  store.assertAvailable();
});

test('interaction feedback database failure retains the original request and closes admission', (t) => {
  const files = fixture(t);
  const initial = files.open();
  loadConversationContent(initial);
  const state = { id: 'request', contract: CompletionInteraction.key, revision: 0, delivery: 'prepared', request: { messages: [{ role: 'user', content: 'question' }] } };
  initial.interactions.create(state);
  initial.interactions.commit({ expectedRevision: 0, state: { ...state, revision: 1, delivery: 'started' } });
  initial.close();
  const database = new DatabaseSync(files.path);
  database.exec("CREATE TRIGGER reject_reply BEFORE UPDATE ON completion_interactions WHEN NEW.revision = 2 BEGIN SELECT RAISE(ABORT, 'feedback fault'); END;");
  database.close();
  const store = files.open();
  assert.throws(() => store.interactions.commit({ expectedRevision: 1, state: { ...state, revision: 2, delivery: 'started', feedback: { id: 'feedback', payload: reply() } } }), PersistenceError);
  assert.throws(() => store.assertAvailable(), PersistenceError);
  store.close();
  const reopened = files.open();
  assert.equal(reopened.interactions.read(state.id).revision, 1);
  assert.equal(reopened.interactions.read(state.id).feedback, undefined);
});
