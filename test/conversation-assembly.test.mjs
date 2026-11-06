import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createConversationInteractions, createConversationResources, createMaterialConversationScene, loadConversationContent, restoreConversationContent } from '@capix/conversation-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { PersistenceError } from '@capix/diagnostics';
import { Runner } from '@capix/server-runtime';

const messageRef = (key) => ({ source: 'messages', key });
const memoryRef = (key) => ({ source: 'memories', key });
const reply = (text) => ({ id: 'assembly-offline', model: 'fixture', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null });

async function database(t) {
  const directory = await mkdtemp(join(tmpdir(), 'capix-assembly-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'conversation.sqlite');
}

function modelFixture({ propose, answer } = {}) {
  const inputs = { answers: [], proposals: [] };
  return {
    inputs,
    async complete(request, controls = {}) {
      const input = JSON.parse(request.messages.find((message) => message.role === 'user').content);
      if (request.responseFormat === 'text') {
        inputs.answers.push(input);
        assert.equal(request.stream, true);
        if (answer) return answer(input, controls);
        controls.emit?.('This is a preview, not the saved answer.');
        const remembered = input.materials.entries.find((entry) => entry.source === 'memories');
        return reply(`Remembered: ${remembered?.value.content ?? 'none'}. Query: ${input.query.content}`);
      }
      assert.equal(request.responseFormat, 'json_object');
      assert.notEqual(request.stream, true);
      inputs.proposals.push(input);
      if (propose) return propose(input);
      const latest = input.messages.findLast(({ message }) => message.role === 'user');
      const previous = input.memories[0];
      return reply(JSON.stringify({ changes: [{ action: previous ? 'update' : 'create', memoryId: previous?.id ?? null, change: 'Remember the new explicit preference', sourceIndexes: [latest.index], result: { topic: 'Preference', content: latest.message.content, sourceIndexes: [latest.index] } }] }));
    },
  };
}

function assemble(path, model, adaptStore = (store) => store) {
  const store = ConversationStore.open(path);
  const ports = adaptStore(store);
  try {
    const content = loadConversationContent(ports);
    const interactions = createConversationInteractions(model);
    const resources = createConversationResources(content, model, ports.view);
    const runner = new Runner(createMaterialConversationScene(), resources, interactions, { validate: () => void ports.assertAvailable() }).build();
    const events = [];
    const unsubscribe = runner.output.subscribe({ receive: (event) => void events.push(event) });
    let closed = false;
    return {
      store,
      ports,
      content,
      interactions,
      runner,
      events,
      async close() {
        if (closed) return;
        closed = true;
        unsubscribe();
        await interactions.settled();
        interactions.close();
        store.close();
      },
    };
  } catch (error) {
    store.close();
    throw error;
  }
}

test('complete assembly saves streamed answers, memory and membership, then a new Runner uses the restored entities', async (t) => {
  const path = await database(t);
  const firstModel = modelFixture();
  const first = assemble(path, firstModel);
  t.after(() => first.close());
  const firstAnswer = await first.runner.run('Use concise Chinese');
  const firstState = first.store.load();
  const memoryId = first.content.memories.values()[0].id;
  assert.equal(firstAnswer, 'Remembered: none. Query: Use concise Chinese');
  assert.equal(first.content.transcript.get(1).content, firstAnswer);
  assert.deepEqual(first.content.view.members(), [messageRef(0), messageRef(1), memoryRef(memoryId)]);
  assert.deepEqual(
    first.events.filter((event) => event.kind === 'delta').map((event) => event.delta),
    ['This is a preview, not the saved answer.'],
  );
  assert.equal(first.events.find((event) => event.kind === 'completed').result, firstAnswer);
  assert.equal(firstModel.inputs.answers.length, 1);
  assert.equal(firstModel.inputs.proposals.length, 1);
  await first.close();

  const secondModel = modelFixture();
  const second = assemble(path, secondModel);
  t.after(() => second.close());
  assert.notEqual(second.runner.id, first.runner.id);
  assert.notEqual(second.runner.scene, first.runner.scene);
  assert.notEqual(second.content.transcript, first.content.transcript);
  assert.equal(second.content.transcript.id, firstState.transcript.id);
  assert.equal(second.content.memories.id, firstState.memories.id);
  assert.deepEqual(second.store.load(), firstState);
  assert.equal(secondModel.inputs.answers.length, 0, 'opening content does not send a model request');
  const secondAnswer = await second.runner.run('Put conclusions first');
  assert.equal(secondAnswer, 'Remembered: Use concise Chinese. Query: Put conclusions first');
  const capturedMemory = secondModel.inputs.answers[0].materials.entries.find((entry) => entry.source === 'memories');
  assert.equal(capturedMemory.key, memoryId);
  assert.equal(capturedMemory.value.content, 'Use concise Chinese');
  assert.equal(second.content.memories.get(memoryId).content, 'Put conclusions first');
  assert.deepEqual(second.content.memories.get(memoryId).sourceIndexes, [2]);
  assert.equal(second.content.memories.values().length, 1);
  assert.equal(second.content.transcript.length, 4);
  assert.equal(secondModel.inputs.proposals[0].acceptedIndex, 3);

  // Membership is saved separately from entity content. A host policy may remove either kind.
  second.content.view.excludeSync([messageRef(0), messageRef(1), messageRef(2), messageRef(3), memoryRef(memoryId)], second.store.view);
  const excluded = second.store.load();
  assert.deepEqual(excluded.view.members, []);
  assert.equal(excluded.transcript.messages.length, 4);
  assert.equal(excluded.memories.items[0].id, memoryId);
  await second.close();

  const thirdModel = modelFixture();
  const third = assemble(path, thirdModel);
  t.after(() => third.close());
  assert.deepEqual(third.content.view.members(), []);
  await third.runner.run('Use short bullet points');
  assert.deepEqual(thirdModel.inputs.answers[0].materials.entries, [], 'restore does not silently reinclude historical content');
  assert.equal(thirdModel.inputs.answers[0].query.index, 4);
  assert.equal(thirdModel.inputs.proposals[0].messages.length, 6, 'maintenance still captures the complete formal prefix');
  assert.equal(thirdModel.inputs.proposals[0].memories[0].id, memoryId);
  assert.equal(third.content.memories.get(memoryId).content, 'Use short bullet points');
  assert.equal(third.content.view.has(memoryRef(memoryId)), false, 'updating a memory does not reactivate it');
  assert.deepEqual(third.content.view.members(), [messageRef(4), messageRef(5)]);
  const finalState = third.store.load();
  await third.close();
  const reopened = ConversationStore.open(path);
  try {
    assert.deepEqual(reopened.load(), finalState);
  } finally {
    reopened.close();
  }
});

test('invalid memory proposal is handled after the saved answer and is not retried on reopening', async (t) => {
  const path = await database(t);
  const model = modelFixture({ propose: () => reply('{invalid json') });
  const current = assemble(path, model);
  t.after(() => current.close());
  const answer = await current.runner.run('Remember my preference');
  assert.equal(current.content.transcript.get(1).content, answer);
  assert.deepEqual(current.content.memories.snapshot(), []);
  assert.deepEqual(current.content.view.members(), [messageRef(0), messageRef(1)]);
  assert.equal(current.events.filter((event) => event.kind === 'completed').length, 1);
  assert.equal(model.inputs.proposals.length, 1);
  await current.close();

  const nextModel = modelFixture();
  const next = assemble(path, nextModel);
  t.after(() => next.close());
  assert.equal(nextModel.inputs.proposals.length, 0);
  await next.runner.run('Another preference');
  assert.equal(nextModel.inputs.proposals.length, 1, 'only the new assistant answer initiates maintenance');
  assert.equal(nextModel.inputs.proposals[0].acceptedIndex, 3);
  assert.deepEqual(next.content.memories.values()[0].sourceIndexes, [2]);
});

// Fail exactly one required synchronous persistence boundary; preserve earlier real DB commits.
function failingPorts(store, reject) {
  let failure;
  const port = (name) => ({
    commit(change) {
      if (failure) throw failure;
      if (reject(name, change)) {
        failure = new PersistenceError(`test.${name}`, new Error('injected write failure'));
        throw failure;
      }
      return store[name].commit(change);
    },
  });
  return {
    transcript: port('transcript'),
    memories: port('memories'),
    view: port('view'),
    load: () => store.load(),
    initialize: (state) => store.initialize(state),
    assertAvailable() {
      if (failure) throw failure;
      store.assertAvailable();
    },
  };
}

test('partial content commits remain truthful across failures and reopening; no hidden retry completes the old submission', async (t) => {
  const cases = [
    { name: 'user append', reject: (name, change) => name === 'transcript' && change.messages?.[0].role === 'user', messages: 0, members: [], answers: 0, proposals: 0 },
    { name: 'user membership', reject: (name) => name === 'view', messages: 1, members: [], answers: 0, proposals: 0 },
    { name: 'assistant append', reject: (name, change) => name === 'transcript' && change.messages?.[0].role === 'assistant', messages: 1, members: [messageRef(0)], answers: 1, proposals: 0 },
    { name: 'memory commit', reject: (name) => name === 'memories', messages: 2, members: [messageRef(0), messageRef(1)], answers: 1, proposals: 1 },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const path = await database(t);
      const model = modelFixture();
      const current = assemble(path, model, (store) => failingPorts(store, scenario.reject));
      t.after(() => current.close());
      await assert.rejects(current.runner.run('First request'), (error) => error instanceof PersistenceError);
      assert.equal(current.runner.isRunning, false);
      assert.equal(current.content.transcript.length, scenario.messages);
      assert.deepEqual(current.content.view.members(), scenario.members);
      assert.deepEqual(current.content.memories.snapshot(), []);
      assert.equal(
        current.events.some((event) => event.kind === 'completed'),
        false,
      );
      assert.equal(model.inputs.answers.length, scenario.answers);
      assert.equal(model.inputs.proposals.length, scenario.proposals);
      const saved = current.store.load();
      await assert.rejects(current.runner.run('Do not admit while the store is unhealthy'), (error) => error instanceof PersistenceError);
      assert.deepEqual(current.store.load(), saved, 'admission does not append another user message');
      await current.close();

      const nextModel = modelFixture();
      const next = assemble(path, nextModel);
      t.after(() => next.close());
      assert.deepEqual(next.store.load(), saved);
      assert.equal(nextModel.inputs.answers.length + nextModel.inputs.proposals.length, 0);
      await next.runner.run('New request');
      assert.equal(next.content.transcript.length, scenario.messages + 2);
      assert.equal(nextModel.inputs.answers.length, 1);
      assert.equal(nextModel.inputs.proposals.length, 1);
      assert.equal(nextModel.inputs.answers[0].query.index, scenario.messages);
      if (scenario.name === 'user membership') assert.equal(next.content.view.has(messageRef(0)), false, 'reopening does not repair an earlier failed membership operation');
    });
  }
});

test('cancelling the local assembly call leaves its independent request alive and cannot append the late reply on reopening', { timeout: 5000 }, async (t) => {
  const path = await database(t);
  const external = Promise.withResolvers();
  const previewed = Promise.withResolvers();
  let publish;
  const model = modelFixture({
    answer(_input, controls) {
      assert.equal(controls.signal, undefined, 'the independent sender does not borrow the invocation signal');
      publish = controls.emit;
      controls.emit('pending preview');
      return external.promise;
    },
  });
  const current = assemble(path, model);
  t.after(async () => {
    external.resolve(reply('late answer'));
    await current.close();
  });
  const unsubscribe = current.runner.output.subscribe({ receive: (event) => void (event.kind === 'delta' && previewed.resolve()) });
  const running = current.runner.run('Cancelled request');
  const rejected = assert.rejects(running, { code: 'INVOCATION_CANCELLED' });
  await previewed.promise;
  assert.equal(current.runner.cancel(), true);
  await rejected;
  unsubscribe();
  assert.equal(current.runner.isRunning, false);
  assert.equal(current.interactions.active, true);
  assert.equal(current.content.transcript.length, 1);
  assert.deepEqual(current.content.view.members(), [messageRef(0)]);
  publish('after local cancellation');
  external.resolve(reply('late answer'));
  await current.interactions.settled();
  assert.equal(current.interactions.active, false);
  assert.deepEqual(
    current.events.filter((event) => event.kind === 'delta').map((event) => event.delta),
    ['pending preview'],
  );
  assert.equal(current.content.transcript.length, 1);
  assert.equal(model.inputs.proposals.length, 0);
  await current.close();

  const nextModel = modelFixture();
  const next = assemble(path, nextModel);
  t.after(() => next.close());
  assert.deepEqual(next.content.transcript.snapshot(), [{ role: 'user', content: 'Cancelled request' }]);
  await next.runner.run('New request');
  assert.equal(next.content.transcript.length, 3);
  assert.equal(
    next.content.transcript.snapshot().some((message) => message.content === 'late answer'),
    false,
  );
  assert.equal(nextModel.inputs.answers.length, 1);
});

test('a real SQLite memory-write failure gates the assembled Runner before the next input and keeps the already saved answer', async (t) => {
  const path = await database(t);
  const initial = ConversationStore.open(path);
  loadConversationContent(initial);
  initial.close();
  const fault = new DatabaseSync(path);
  fault.exec("CREATE TRIGGER reject_memory BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;");
  fault.close();
  const model = modelFixture();
  const current = assemble(path, model);
  t.after(() => current.close());
  await assert.rejects(current.runner.run('Preference'), (error) => error instanceof PersistenceError);
  assert.equal(current.content.transcript.length, 2);
  assert.deepEqual(current.content.memories.snapshot(), []);
  assert.deepEqual(current.content.view.members(), [messageRef(0), messageRef(1)]);
  assert.equal(
    current.events.some((event) => event.kind === 'completed'),
    false,
  );
  assert.throws(() => current.store.assertAvailable(), PersistenceError);
  await assert.rejects(current.runner.run('Must not append'), (error) => error instanceof PersistenceError);
  assert.equal(current.content.transcript.length, 2);
  assert.equal(model.inputs.answers.length, 1);
  assert.equal(model.inputs.proposals.length, 1);
  const answer = current.content.transcript.get(1).content;
  await current.close();
  const reopened = ConversationStore.open(path);
  try {
    const saved = reopened.load();
    assert.deepEqual(saved.transcript.messages, [
      { role: 'user', content: 'Preference' },
      { role: 'assistant', content: answer },
    ]);
    assert.deepEqual(saved.memories.items, []);
    assert.deepEqual(saved.view.members, [messageRef(0), messageRef(1)]);
  } finally {
    reopened.close();
  }
});

test('content loading rejects mismatched source identity, scope and nonexistent members before runtime construction', async (t) => {
  const path = await database(t);
  const current = assemble(path, modelFixture());
  t.after(() => current.close());
  const state = current.store.load();
  const mismatches = [
    { ...state, memories: { ...state.memories, transcriptId: 'another-transcript' } },
    { ...state, view: { ...state.view, sources: { ...state.view.sources, messages: { id: 'another-transcript', scope: 'whole' } } } },
    { ...state, view: { ...state.view, sources: { ...state.view.sources, memories: { id: state.memories.id, scope: 'keys:[]' } } } },
    { ...state, view: { ...state.view, members: [messageRef(0)] } },
    { ...state, view: { ...state.view, members: [memoryRef('missing-memory')] } },
  ];
  for (const invalid of mismatches) assert.throws(() => restoreConversationContent(invalid));
  assert.deepEqual(current.store.load(), state);
});
