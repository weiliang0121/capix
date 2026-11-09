import { modelReplyText } from '@weiliang0121/capix-model-provider';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompletionReplyNode, CompletionInteractionResource, ModelReplyPending, CompletionInteraction } from '@capix/conversation-service';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { Interactions } from '@weiliang0121/capix-interaction';
import { Resource } from '@weiliang0121/capix-resources';
import { Resources, Runner, Scene } from '@weiliang0121/capix-runtime';
import { modelReply } from './fixtures/conversation-model.mjs';
import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';

const input = Object.freeze({ role: 'user', content: '请总结已有讨论。' });
const answer = '已保存的外部回答。';

function interactionStore() {
  const states = new Map();
  const commits = [];
  return {
    commits,
    create(state) {
      assert.equal(states.has(state.id), false);
      assert.equal(state.revision, 0);
      states.set(state.id, structuredClone(state));
    },
    commit({ expectedRevision, state }) {
      const previous = states.get(state.id);
      assert.ok(previous);
      assert.equal(previous.revision, expectedRevision);
      assert.equal(state.revision, expectedRevision + 1);
      assert.equal(state.contract, previous.contract);
      assert.deepEqual(state.request, previous.request);
      states.set(state.id, structuredClone(state));
      commits.push(structuredClone(state));
    },
    read(id) {
      const state = states.get(id);
      return state === undefined ? undefined : structuredClone(state);
    },
  };
}

function messagesWithPersistence() {
  let saved;
  let nextFailure;
  const attempts = [];
  const commits = [];
  const transcript = new Transcript([], {
    persistence: {
      commit(change) {
        assert.equal(change.kind, 'append');
        assert.equal(change.transcriptId, saved.id);
        assert.equal(change.expectedRevision, saved.revision);
        assert.equal(change.revision, saved.revision + 1);
        assert.equal(change.start, saved.messages.length);
        assert.equal(change.fixed, undefined, 'this study uses ordinary append, not a fabricated reception receipt');
        attempts.push(structuredClone(change));
        if (nextFailure) {
          const failure = nextFailure;
          nextFailure = undefined;
          throw failure;
        }
        saved = { ...saved, revision: change.revision, messages: [...saved.messages, ...structuredClone(change.messages)] };
        commits.push(structuredClone(change));
      },
    },
  });
  saved = structuredClone(transcript.exportState());
  transcript.append(input);
  return {
    transcript,
    attempts,
    commits,
    rejectNextAppend() {
      const failure = new PersistenceError('transcript.append', new Error('injected failure before storage commit'));
      nextFailure = failure;
      return failure;
    },
    snapshot: () => structuredClone(saved),
  };
}

function acceptingReader(interactions, transcript) {
  const scene = new Scene({
    name: 'accept-stored-model-reply',
    deps: { messages: TranscriptResource.append.request() },
    output: { result: (value) => value },
  }).add({ reply: createCompletionReplyNode(0) });
  scene.run = (work) =>
    work.children.reply.invoke(work.input, {
      result: {
        succeeded(reply) {
          const content = modelReplyText(reply);
          work.resources.messages.append([{ role: 'assistant', content }]);
          return content;
        },
      },
    });
  // This consumer has no start resource. Its input is the reference retained by the host.
  const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
  const runner = new Runner(scene, resources, interactions).build();
  const outputs = [];
  const observations = [];
  runner.output.subscribe({ receive: (event) => void outputs.push(event) });
  runner.observation.subscribe({ receive: (event) => void observations.push(event) });
  return { runner, outputs, observations };
}

function entries(reader) {
  return reader.observations.filter((event) => event.source === 'entry' && event.fact.kind === 'settled');
}

function assertStoredMessages(store, messages) {
  assert.deepEqual(store.transcript.snapshot(), messages);
  assert.deepEqual(store.transcript.exportState(), store.snapshot());
  assert.equal(store.transcript.revision, store.commits.length);
}

test('a failed assistant commit leaves saved feedback readable and a fresh invocation accepts it without resending', async () => {
  const storage = interactionStore();
  const messages = messagesWithPersistence();
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send(request) {
      sends++;
      assert.deepEqual(request.messages, [input]);
      return modelReply(answer);
    },
    persistence: storage,
  });
  // Reference ownership comes from the start result, never from passive observation.
  const channel = interactions.bind(CompletionInteraction);
  const reference = channel.start({ messages: [input] });
  await interactions.settled();
  const savedFeedback = storage.read(reference.id);
  assert.equal(savedFeedback.revision, 2);
  assert.equal(modelReplyText(savedFeedback.feedback.payload), answer);
  const reader = acceptingReader(interactions, messages.transcript);
  const failure = messages.rejectNextAppend();

  await assert.rejects(reader.runner.run(reference), (error) => error === failure);
  assert.equal(reader.runner.isRunning, false);
  assertStoredMessages(messages, [input]);
  assert.equal(messages.attempts.length, 2, 'the feedback reached the parent reception callback');
  assert.equal(
    reader.outputs.some((event) => event.kind === 'completed'),
    false,
  );
  assert.equal(entries(reader)[0].fact.status, 'failed');
  assert.deepEqual(storage.read(reference.id), savedFeedback);
  assert.deepEqual(channel.read(reference), { kind: 'received', feedback: savedFeedback.feedback });

  assert.equal(await reader.runner.run(structuredClone(reference)), answer);
  assertStoredMessages(messages, [input, { role: 'assistant', content: answer }]);
  assert.equal(sends, 1);
  assert.equal(storage.commits.length, 2, 'message reception does not rewrite the external exchange');
  assert.deepEqual(storage.read(reference.id), savedFeedback);
  const settled = entries(reader);
  assert.deepEqual(
    settled.map((event) => event.fact.status),
    ['failed', 'succeeded'],
  );
  assert.notEqual(settled[0].entryId, settled[1].entryId);
  const roots = reader.observations.filter((event) => event.source === 'invocation' && event.fact.kind === 'started' && event.fact.identity.kind === 'scene');
  assert.equal(roots.length, 2);
  assert.notEqual(roots[0].fact.identity.contextId, roots[1].fact.identity.contextId);
  assert.deepEqual(
    reader.outputs.filter((event) => event.kind === 'completed').map((event) => ({ entryId: event.entryId, result: event.result })),
    [{ entryId: settled[1].entryId, result: answer }],
  );
  interactions.close();
});

test('feedback arriving after local invocation exit survives a later message failure and can be accepted by another invocation', { timeout: 3000 }, async () => {
  const response = Promise.withResolvers();
  const storage = interactionStore();
  const messages = messagesWithPersistence();
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send() {
      sends++;
      return response.promise;
    },
    persistence: storage,
  });
  const reference = interactions.bind(CompletionInteraction).start({ messages: [input] });
  const reader = acceptingReader(interactions, messages.transcript);

  await assert.rejects(reader.runner.run(reference), (error) => {
    assert.ok(error instanceof ModelReplyPending);
    assert.deepEqual(error.reference, reference);
    return true;
  });
  assert.equal(reader.runner.isRunning, false);
  assert.equal(interactions.active, true);
  assert.equal(storage.read(reference.id).feedback, undefined);
  assert.equal(messages.attempts.length, 1, 'an expired read cannot enter successful reception');
  const exitedEvents = reader.observations.length;
  response.resolve(modelReply(answer));
  await interactions.settled();
  assert.equal(reader.observations.length, exitedEvents, 'late external feedback does not revive the finished invocation');
  const savedFeedback = storage.read(reference.id);
  assert.equal(modelReplyText(savedFeedback.feedback.payload), answer);
  const failure = messages.rejectNextAppend();
  await assert.rejects(reader.runner.run(reference), (error) => error === failure);
  assertStoredMessages(messages, [input]);
  assert.equal(
    reader.outputs.some((event) => event.kind === 'completed'),
    false,
  );

  assert.equal(await reader.runner.run(reference), answer);
  assertStoredMessages(messages, [input, { role: 'assistant', content: answer }]);
  assert.equal(sends, 1);
  assert.deepEqual(storage.read(reference.id), savedFeedback);
  assert.deepEqual(
    entries(reader).map((event) => event.fact.status),
    ['failed', 'failed', 'succeeded'],
  );
  assert.equal(new Set(entries(reader).map((event) => event.entryId)).size, 3);
  assert.equal(reader.outputs.filter((event) => event.kind === 'completed').length, 1);
  interactions.close();
});

test('a rebuilt interaction host reads the saved feedback after message failure without restoring an invocation or sending again', async () => {
  const storage = interactionStore();
  const messages = messagesWithPersistence();
  let sends = 0;
  const original = new Interactions().register(CompletionInteraction, {
    send() {
      sends++;
      return modelReply(answer);
    },
    persistence: storage,
  });
  const reference = original.bind(CompletionInteraction).start({ messages: [input] });
  await original.settled();
  const first = acceptingReader(original, messages.transcript);
  const failure = messages.rejectNextAppend();
  await assert.rejects(first.runner.run(reference), (error) => error === failure);
  assertStoredMessages(messages, [input]);
  original.close();

  const before = storage.read(reference.id);
  const restored = new Interactions().register(CompletionInteraction, {
    send: () => assert.fail('reading saved feedback cannot create another external request'),
    persistence: {
      create: () => assert.fail('reading saved feedback cannot create another interaction'),
      commit: () => assert.fail('reading saved feedback must be read-only'),
      read: (id) => storage.read(id),
    },
  });
  const fresh = acceptingReader(restored, messages.transcript);
  assert.equal(await fresh.runner.run(structuredClone(reference)), answer);
  assertStoredMessages(messages, [input, { role: 'assistant', content: answer }]);
  assert.equal(sends, 1);
  assert.equal(restored.active, false);
  assert.deepEqual(storage.read(reference.id), before);
  assert.deepEqual(
    entries(first).map((event) => event.fact.status),
    ['failed'],
  );
  assert.deepEqual(
    entries(fresh).map((event) => event.fact.status),
    ['succeeded'],
  );
  restored.close();
});

test('repeated successful feedback reads do not resend, but ordinary append does not deduplicate business effects across invocations', async () => {
  const storage = interactionStore();
  const messages = messagesWithPersistence();
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send() {
      sends++;
      return modelReply(answer);
    },
    persistence: storage,
  });
  const reference = interactions.bind(CompletionInteraction).start({ messages: [input] });
  await interactions.settled();
  const before = storage.read(reference.id);
  const reader = acceptingReader(interactions, messages.transcript);
  assert.equal(await reader.runner.run(reference), answer);
  assert.equal(await reader.runner.run(reference), answer);

  // A saved Interaction reply is a reusable input, not a receipt for a Transcript write.
  assertStoredMessages(messages, [input, { role: 'assistant', content: answer }, { role: 'assistant', content: answer }]);
  assert.equal(sends, 1);
  assert.equal(messages.commits.length, 3);
  assert.deepEqual(storage.read(reference.id), before);
  assert.deepEqual(
    entries(reader).map((event) => event.fact.status),
    ['succeeded', 'succeeded'],
  );
  interactions.close();
});
