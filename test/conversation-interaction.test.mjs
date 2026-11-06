import { modelReplyText } from '@capix/model-provider';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationScene, createInteractionAnswer, createCompletionReplyNode, HistoryResource, CompletionInteractionResource, ModelReplyPending, CompletionInteraction } from '@capix/conversation-service';
import { Interactions } from '@capix/interaction';
import { PersistenceError } from '@capix/diagnostics';
import { Resource } from '@capix/resources';
import { Node, Resources, Runner, Scene } from '@capix/server-runtime';
import { modelReply } from './fixtures/conversation-model.mjs';
import { Transcript, TranscriptResource } from '@capix/transcript';

const messages = Object.freeze([Object.freeze({ role: 'user', content: 'question' })]);

function memoryPersistence() {
  const states = new Map();
  return {
    states,
    create(state) {
      assert.equal(states.has(state.id), false);
      states.set(state.id, structuredClone(state));
    },
    commit({ expectedRevision, state }) {
      assert.equal(states.get(state.id)?.revision, expectedRevision);
      states.set(state.id, structuredClone(state));
    },
    read(id) {
      return states.get(id);
    },
  };
}

function conversation(interactions, transcript = new Transcript(), waitMs = 1000) {
  const entity = new Resource(transcript);
  const resources = new Resources().register(entity, TranscriptResource.append).register(entity, HistoryResource).registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
  return new Runner(createConversationScene(createInteractionAnswer({ waitMs })), resources, interactions).build();
}

function reader(interactions, waitMs = 1000) {
  return new Runner(new Scene(createCompletionReplyNode(waitMs)), new Resources().registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction), interactions).build();
}

test('interaction-backed conversation builds without sending and sends one fixed request per answer', async () => {
  const requests = [];
  const outputs = [];
  const storage = memoryPersistence();
  const interactions = new Interactions().register(CompletionInteraction, {
    send(request) {
      const history = request.messages;
      assert.equal(request.stream, true);
      requests.push(history);
      assert.ok(Object.isFrozen(history));
      assert.ok(history.every(Object.isFrozen));
      return modelReply(`answer ${requests.length}`);
    },
    persistence: storage,
  });
  const transcript = new Transcript();
  const runner = conversation(interactions, transcript);
  runner.output.subscribe({ receive: (event) => void outputs.push(event) });
  assert.equal(requests.length, 0);
  assert.equal(storage.states.size, 0);
  assert.equal(interactions.active, false);

  assert.equal(await runner.run('first'), 'answer 1');
  assert.equal(await runner.run('second'), 'answer 2');
  assert.equal(requests.length, 2);
  assert.equal(storage.states.size, 2);
  assert.deepEqual(requests[1], [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'answer 1' },
    { role: 'user', content: 'second' },
  ]);
  assert.deepEqual(transcript.snapshot(), [...requests[1], { role: 'assistant', content: 'answer 2' }]);
  assert.equal(
    outputs.some((event) => event.kind === 'delta'),
    false,
  );
  await interactions.settled();
  interactions.close();
});

test('cancelled local waiting releases the Runner while the model continues and its late feedback remains read-only', { timeout: 3000 }, async () => {
  const response = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  let sends = 0;
  let reference;
  const interactions = new Interactions().register(CompletionInteraction, {
    send() {
      sends++;
      return response.promise;
    },
    observation: {
      receive(fact) {
        reference = { id: fact.state.id, contract: fact.state.contract };
      },
    },
  });
  const transcript = new Transcript();
  const runner = conversation(interactions, transcript);
  runner.observation.subscribe({
    receive(event) {
      if (event.source === 'resource' && event.fact.offerId === CompletionInteractionResource.feedback.request().offer.id && event.fact.phase === 'started') waiting.resolve();
    },
  });
  const run = runner.run('question');
  const rejected = assert.rejects(run, { code: 'INVOCATION_CANCELLED' });
  await waiting.promise;
  assert.equal(runner.cancel(), true);
  await rejected;

  assert.equal(runner.isRunning, false);
  assert.equal(interactions.active, true);
  assert.equal(sends, 1);
  assert.deepEqual(transcript.snapshot(), messages);
  response.resolve(modelReply('late answer'));
  await interactions.settled();
  assert.equal(modelReplyText(await reader(interactions).run(reference)), 'late answer');
  assert.equal(sends, 1);
  assert.deepEqual(transcript.snapshot(), messages, 'reading feedback does not automatically accept a conversation answer');
  interactions.close();
});

test('wait expiry returns the exact exchange reference and a fresh reader consumes it without resending', { timeout: 3000 }, async () => {
  const response = Promise.withResolvers();
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send() {
      sends++;
      return response.promise;
    },
  });
  const transcript = new Transcript();
  const runner = conversation(interactions, transcript, 0);
  let pending;
  await assert.rejects(runner.run('question'), (error) => {
    pending = error;
    return error instanceof ModelReplyPending;
  });
  assert.ok(Object.isFrozen(pending.reference));
  assert.equal(pending.reference.contract, CompletionInteraction.key);
  assert.equal(runner.isRunning, false);
  assert.equal(interactions.active, true);
  response.resolve(modelReply('late answer'));
  await interactions.settled();
  const fresh = reader(interactions, 0);
  assert.equal(modelReplyText(await fresh.run(pending.reference)), 'late answer');
  assert.equal(modelReplyText(await fresh.run(structuredClone(pending.reference))), 'late answer');
  assert.equal(sends, 1);
  assert.deepEqual(transcript.snapshot(), messages);
  interactions.close();
});

test('persisted feedback can be read by rebuilt resource and interaction hosts without a new send or write', async () => {
  const storage = memoryPersistence();
  const original = new Interactions().register(CompletionInteraction, { send: () => modelReply('saved answer'), persistence: storage });
  assert.equal(await conversation(original).run('question'), 'saved answer');
  await original.settled();
  const state = [...storage.states.values()][0];
  const reference = { id: state.id, contract: state.contract };
  original.close();
  const restored = new Interactions().register(CompletionInteraction, {
    send: () => assert.fail('reading persisted feedback must not resend'),
    persistence: {
      create: () => assert.fail('restore must not create another request'),
      commit: () => assert.fail('restore must not mutate persisted feedback'),
      read: (id) => storage.read(id),
    },
  });
  const restoredReader = reader(restored, 0);
  assert.equal(modelReplyText(await restoredReader.run(reference)), 'saved answer');
  assert.equal(modelReplyText(await restoredReader.run(reference)), 'saved answer');
  assert.equal(storage.states.size, 1);
  assert.equal(restored.active, false);
  restored.close();
});

test('a persisted pending exchange is unavailable in a new host and is never resent', { timeout: 3000 }, async () => {
  const storage = memoryPersistence();
  const response = Promise.withResolvers();
  const original = new Interactions().register(CompletionInteraction, { send: () => response.promise, persistence: storage });
  const reference = original.bind(CompletionInteraction).start({ messages });
  const saved = structuredClone(storage.read(reference.id));
  const restored = new Interactions().register(CompletionInteraction, {
    send: () => assert.fail('an unavailable exchange cannot be resent by reading'),
    persistence: { create() {}, commit() {}, read: () => saved },
  });
  await assert.rejects(reader(restored, 0).run(reference), { code: 'INTERACTION_RESTORED_PENDING' });
  assert.equal(restored.active, false);
  response.resolve(modelReply('eventual original answer'));
  await original.settled();
  original.close();
  restored.close();
});

test('unknown and cross-contract references fail without starting a request', async () => {
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, { send: () => (++sends, modelReply('answer')) });
  const run = reader(interactions, 0);
  await assert.rejects(run.run({ id: 'unknown', contract: CompletionInteraction.key }), { code: 'INTERACTION_UNKNOWN' });
  await assert.rejects(run.run({ id: 'unknown', contract: 'other' }), { code: 'INTERACTION_CONTRACT_MISMATCH' });
  assert.equal(sends, 0);
  interactions.close();
});

test('unavailable model feedback preserves the original sender error through the reader', async () => {
  const fault = new Error('provider unavailable');
  const interactions = new Interactions().register(CompletionInteraction, { send: () => Promise.reject(fault) });
  const reference = interactions.bind(CompletionInteraction).start({ messages });
  await interactions.settled();
  await assert.rejects(reader(interactions, 0).run(reference), (error) => error === fault);
  interactions.close();
});

test('model request and feedback schemas reject invalid data at the interaction boundary', async (t) => {
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, { send: () => (++sends, modelReply('answer')) });
  const channel = interactions.bind(CompletionInteraction);
  for (const input of [[], 'question', { messages: [] }, { messages: [{ role: 'user', content: 42 }] }, { messages: [{ role: 'user', content: 'question', extra: true }] }]) assert.throws(() => channel.start(input));
  assert.equal(sends, 0);
  interactions.close();

  for (const reply of ['', ' \n', 42, { text: 'answer' }]) {
    await t.test(JSON.stringify(reply), async () => {
      const transcript = new Transcript();
      const external = new Interactions().register(CompletionInteraction, { send: () => reply });
      await assert.rejects(conversation(external, transcript).run('question'));
      await external.settled();
      assert.deepEqual(transcript.snapshot(), messages);
      external.close();
    });
  }
});

for (const stage of ['create', 'dispatch', 'feedback']) {
  test(`${stage} persistence failure never becomes a successful conversation answer`, async () => {
    const storage = memoryPersistence();
    let sends = 0;
    const interactions = new Interactions().register(CompletionInteraction, {
      send() {
        sends++;
        return modelReply('unsaved answer');
      },
      persistence: {
        create(state) {
          if (stage === 'create') throw new Error('request store unavailable');
          storage.create(state);
        },
        commit(change) {
          if ((stage === 'dispatch' && change.state.delivery === 'started') || (stage === 'feedback' && change.state.feedback)) throw new Error('commit unavailable');
          storage.commit(change);
        },
      },
    });
    const transcript = new Transcript();
    await assert.rejects(conversation(interactions, transcript).run('question'), (error) => error instanceof PersistenceError);
    await interactions.settled();
    assert.equal(sends, stage === 'feedback' ? 1 : 0);
    assert.deepEqual(transcript.snapshot(), messages);
    assert.ok([...storage.states.values()].every((state) => state.feedback === undefined));
    interactions.close();
  });
}

test('required request persistence cannot be replaced by a resource failure callback', async () => {
  let fallback = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send: () => assert.fail('failed persistence cannot send'),
    persistence: {
      create: () => {
        throw new Error('request storage unavailable');
      },
      commit() {},
    },
  });
  const node = new Node({
    deps: { requests: CompletionInteractionResource.start.request() },
    run: (work) =>
      work.resources.requests.start(
        { messages },
        {
          result: {
            failed: () => {
              fallback++;
              return { id: 'fake', contract: CompletionInteraction.key };
            },
          },
        },
      ),
  });
  const runner = new Runner(new Scene(node), new Resources().registerInteraction(CompletionInteractionResource.start, CompletionInteraction), interactions).build();
  await assert.rejects(runner.run(null), (error) => error instanceof PersistenceError);
  assert.equal(fallback, 0);
  interactions.close();
});

test('required feedback persistence cannot be replaced by a parent child-failure callback', async () => {
  let fallback = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send: () => modelReply('unsaved answer'),
    persistence: {
      create() {},
      commit(change) {
        if (change.state.feedback) throw new Error('reply storage unavailable');
      },
    },
  });
  const scene = new Scene().add({ answer: createInteractionAnswer({ waitMs: 1000 }) });
  scene.run = (work) =>
    work.children.answer.invoke(messages, {
      result: {
        failed: () => {
          fallback++;
          return 'fake answer';
        },
      },
    });
  const resources = new Resources().registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
  await assert.rejects(new Runner(scene, resources, interactions).build().run(null), (error) => error instanceof PersistenceError);
  await interactions.settled();
  assert.equal(fallback, 0);
  interactions.close();
});
