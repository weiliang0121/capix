import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Interaction } from '@weiliang0121/capix-interaction';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { Transcript } from '@weiliang0121/capix-transcript';
import { Memories } from '@weiliang0121/capix-memory';
import { SqliteObserverStore, initializeObserver } from '@capix/observer-service';

const contract = {
  key: 'fixture-model-v1',
  request(value) {
    assert.equal(typeof value.prompt, 'string');
    return value;
  },
  reply(value) {
    assert.equal(typeof value.content, 'string');
    return value;
  },
};

const reply = { id: 'provider-output', model: 'fixture', content: '{ not valid application JSON', finishReason: 'stop', usage: null };

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'capix-interaction-'));
  const path = join(directory, 'observer.sqlite');
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    path,
    open() {
      const store = SqliteObserverStore.open(path);
      stores.push(store);
      return store;
    },
    edit(work) {
      const database = new DatabaseSync(path);
      try {
        return work(database);
      } finally {
        database.close();
      }
    },
  };
}

function create(store) {
  return new Interaction({ prompt: 'saved request' }, { contract, persistence: store.interactions });
}

test('interaction feedback survives restart independently of content metadata and business parsing', async (t) => {
  const disk = fixture(t);
  const store = disk.open();
  const interaction = create(store);
  let sends = 0;
  interaction.start(() => {
    sends += 1;
    assert.equal(store.interactions.read(interaction.id).delivery, 'started', 'dispatch intent is durable before any send');
    return reply;
  });
  await interaction.settled();
  assert.equal(sends, 1);
  assert.equal(store.loadContent(), undefined, 'independent interactions do not fabricate a conversation');
  const expected = interaction.exportState();
  assert.deepEqual(store.interactions.read(interaction.id), expected);
  assert.throws(() => JSON.parse(interaction.read().feedback.payload.content), SyntaxError, 'business interpretation remains separate from capture');
  store.close();

  const restoredStore = disk.open();
  const state = restoredStore.interactions.read(interaction.id);
  assert.deepEqual(state, expected);
  const firstReader = Interaction.restore(state, { contract });
  const secondReader = Interaction.restore(state, { contract });
  assert.deepEqual((await firstReader.wait({ waitMs: 100 })).feedback.payload, reply);
  assert.deepEqual((await secondReader.wait({ waitMs: 100 })).feedback.payload, reply);
  assert.throws(() => firstReader.start(() => sends++), /read-only/);
  assert.equal(sends, 1);
  assert.equal(restoredStore.interactions.read('not-saved'), undefined);
  assert.equal(restoredStore.failure, undefined);
});

test('prepared and started states restore as unavailable and cannot resend', (t) => {
  const disk = fixture(t);
  const store = disk.open();
  const prepared = create(store);
  const started = create(store);
  const state = started.exportState();
  store.interactions.commit({ expectedRevision: state.revision, state: { ...state, revision: 1, delivery: 'started' } });
  store.close();
  const reopened = disk.open();
  for (const id of [prepared.id, started.id]) {
    const restored = Interaction.restore(reopened.interactions.read(id), { contract });
    assert.equal(restored.read().kind, 'unavailable');
    assert.equal(restored.read().error.code, 'INTERACTION_RESTORED_PENDING');
    assert.throws(() => restored.start(() => reply), /read-only/);
  }
});

test('delivery failure is retained without claiming remote nonexecution, and later feedback does not erase it', async (t) => {
  const disk = fixture(t);
  const store = disk.open();
  const interaction = create(store);
  interaction.start(() => Promise.reject(new Error('connection lost after send')));
  await interaction.settled();
  const failed = store.interactions.read(interaction.id);
  assert.equal(failed.delivery, 'started');
  assert.equal(failed.failure.message, 'connection lost after send');
  interaction.receive({ id: 'late-reply', payload: reply });
  const received = store.interactions.read(interaction.id);
  assert.deepEqual(received.failure, failed.failure);
  assert.deepEqual(received.feedback.payload, reply);
  interaction.receive({ id: 'late-reply', payload: reply });
  assert.equal(store.interactions.read(interaction.id).revision, received.revision, 'identical feedback is a no-op');
  store.close();
  const reopened = disk.open();
  const restored = Interaction.restore(reopened.interactions.read(interaction.id), { contract });
  assert.equal(restored.read().kind, 'received');
});

for (const [label, mutate] of [
  ['stale revision', (state) => ({ expectedRevision: 0, state: { ...state, revision: 2, feedback: { id: 'reply', payload: reply } } })],
  ['fixed request', (state) => ({ expectedRevision: 1, state: { ...state, revision: 2, request: { prompt: 'different request' } } })],
  ['contract identity', (state) => ({ expectedRevision: 1, state: { ...state, revision: 2, contract: 'other-contract' } })],
  ['delivery regression', (state) => ({ expectedRevision: 1, state: { ...state, revision: 2, delivery: 'prepared' } })],
]) {
  test(`interaction commit rejects ${label} atomically and blocks subsequent required writes`, (t) => {
    const disk = fixture(t);
    const store = disk.open();
    const interaction = create(store);
    const started = { ...interaction.exportState(), revision: 1, delivery: 'started' };
    store.interactions.commit({ expectedRevision: 0, state: started });
    assert.throws(() => store.interactions.commit(mutate(started)), /保存或加载失败/);
    assert.equal(store.failure.code, 'PERSISTENCE_UNAVAILABLE');
    assert.throws(
      () => create(store),
      (error) => error instanceof PersistenceError && error.operation === 'interaction.create' && error.cause.code === 'PERSISTENCE_UNAVAILABLE' && /存储不可用/.test(error.cause.message),
    );
    store.close();
    assert.deepEqual(disk.open().interactions.read(interaction.id), started);
  });
}

test('duplicate interaction creation and feedback replacement cannot overwrite committed facts', async (t) => {
  const disk = fixture(t);
  const first = disk.open();
  const interaction = create(first);
  const prepared = interaction.exportState();
  assert.throws(() => first.interactions.create(prepared), /保存或加载失败/);
  first.close();
  const store = disk.open();
  const other = create(store);
  other.start(() => reply);
  await other.settled();
  const saved = other.exportState();
  assert.throws(() => store.interactions.commit({ expectedRevision: saved.revision, state: { ...saved, revision: saved.revision + 1, feedback: { id: 'new-feedback', payload: reply } } }), /保存或加载失败/);
  store.close();
  const reopened = disk.open();
  assert.deepEqual(reopened.interactions.read(interaction.id), prepared);
  assert.deepEqual(reopened.interactions.read(other.id), saved);
});

test('failed dispatch registration prevents physical sending', async (t) => {
  const disk = fixture(t);
  disk.open().close();
  disk.edit((database) => database.exec("CREATE TRIGGER reject_start BEFORE UPDATE ON interactions WHEN NEW.revision = 1 BEGIN SELECT RAISE(ABORT, 'fixture'); END;"));
  const store = disk.open();
  const interaction = create(store);
  let sends = 0;
  assert.throws(
    () =>
      interaction.start(() => {
        sends += 1;
        return reply;
      }),
    (error) => error instanceof PersistenceError && error.operation === 'interaction.commit' && error.cause.code === 'PERSISTENCE_UNAVAILABLE' && /保存或加载失败/.test(error.cause.message),
  );
  await interaction.settled();
  assert.equal(sends, 0);
  assert.equal(interaction.exportState().delivery, 'prepared');
  assert.equal(interaction.read().kind, 'unavailable');
  assert.equal(store.failure.code, 'PERSISTENCE_UNAVAILABLE');
  store.close();
  assert.equal(disk.open().interactions.read(interaction.id).delivery, 'prepared');
});

test('failed feedback persistence never publishes the unsaved reply or repeats the external send', async (t) => {
  const disk = fixture(t);
  disk.open().close();
  disk.edit((database) => database.exec("CREATE TRIGGER reject_reply BEFORE UPDATE ON interactions WHEN json_type(NEW.body, '$.feedback') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'fixture'); END;"));
  const store = disk.open();
  const interaction = create(store);
  let sends = 0;
  interaction.start(() => {
    sends += 1;
    return reply;
  });
  const waiting = interaction.wait({ waitMs: 100 });
  await interaction.settled();
  assert.equal((await waiting).kind, 'unavailable');
  assert.equal(interaction.read().kind, 'unavailable');
  assert.equal(interaction.exportState().feedback, undefined);
  assert.equal(sends, 1);
  assert.equal(store.failure.code, 'PERSISTENCE_UNAVAILABLE');
  store.close();
  const reopened = disk.open();
  const saved = reopened.interactions.read(interaction.id);
  assert.equal(saved.delivery, 'started');
  assert.equal(saved.revision, 1);
  assert.equal(saved.feedback, undefined);
});

test('unsupported v1 remains intact without migration', (t) => {
  const disk = fixture(t);
  const store = disk.open();
  const transcript = new Transcript([{ role: 'user', content: 'keep this' }]);
  const memories = new Memories(transcript);
  store.initialize({ transcript: transcript.exportState(), memories: memories.exportState() });
  store.close();
  // The host refuses the old version before loading or rewriting content.
  disk.edit((database) => database.exec('PRAGMA user_version = 1;'));
  assert.throws(() => disk.open(), /Unsupported Observer persistence schema/);
  disk.edit((database) => {
    assert.equal(database.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(JSON.parse(database.prepare('SELECT body FROM messages').get().body).content, 'keep this');
    assert.equal(database.prepare('SELECT count(*) AS count FROM interactions').get().count, 0);
  });
});

test('stored interaction column/body disagreement is a storage failure', (t) => {
  const disk = fixture(t);
  const store = disk.open();
  const interaction = create(store);
  store.close();
  disk.edit((database) => database.prepare('UPDATE interactions SET contract = ? WHERE id = ?').run('changed-binding', interaction.id));
  const reopened = disk.open();
  assert.throws(() => reopened.interactions.read(interaction.id), /保存或加载失败/);
  assert.equal(reopened.failure.code, 'PERSISTENCE_UNAVAILABLE');
});
