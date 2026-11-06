import { modelReplyText } from '@capix/model-provider';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createConversationScene, createInteractionAnswer, createCompletionReplyNode, HistoryResource, CompletionInteractionResource, ModelReplyPending, CompletionInteraction } from '@capix/conversation-service';
import { PersistenceError } from '@capix/diagnostics';
import { Interactions } from '@capix/interaction';
import { Resource } from '@capix/resources';
import { Resources, Runner, Scene } from '@capix/server-runtime';
import { modelReply } from './fixtures/conversation-model.mjs';
import { Transcript, TranscriptResource } from '@capix/transcript';

const question = Object.freeze({ role: 'user', content: 'question' });

function interactionStore() {
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
  };
}

function fixedAnswerWriter(interactions, transcript) {
  const scene = new Scene({ deps: { messages: TranscriptResource.append.request() } }).add({ reply: createCompletionReplyNode(1000) });
  scene.run = (work) =>
    work.children.reply.invoke(work.input, {
      result: {
        succeeded(reply) {
          const content = modelReplyText(reply);
          const append = { position: 'answer', messages: [{ role: 'assistant', content }] };
          const receipt = work.resources.messages.applyFixed(append);
          assert.equal(work.resources.messages.applyFixed(append), receipt, 'the same genuine reception does not write twice');
          return receipt;
        },
      },
    });
  const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
  return new Runner(scene, resources, interactions).build();
}

test('retrying the original conversation after message persistence fails sends again and does not recover a reference from the error', async (t) => {
  const requests = [];
  const storage = interactionStore();
  const interactions = new Interactions().register(CompletionInteraction, {
    send(request) {
      requests.push(request.messages);
      return modelReply(`answer ${requests.length}`);
    },
    persistence: storage,
  });
  t.after(async () => {
    await interactions.settled();
    interactions.close();
  });
  let rejectAnswer = true;
  const failure = new PersistenceError('transcript.append', new Error('message store unavailable'));
  const transcript = new Transcript([], {
    persistence: {
      commit(change) {
        if (rejectAnswer && change.kind === 'append' && change.messages.some((message) => message.role === 'assistant')) throw failure;
      },
    },
  });
  const entity = new Resource(transcript);
  const resources = new Resources().register(entity, TranscriptResource.append).register(entity, HistoryResource).registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
  const runner = new Runner(createConversationScene(createInteractionAnswer({ waitMs: 1000 })), resources, interactions).build();

  await assert.rejects(runner.run(question.content), (error) => {
    assert.equal(error, failure);
    assert.equal(error instanceof ModelReplyPending, false);
    assert.equal('reference' in error, false, 'this helper does not deliver the successful interaction reference with a later message failure');
    return true;
  });
  await interactions.settled();
  assert.equal(runner.isRunning, false);
  assert.equal(requests.length, 1);
  assert.deepEqual(transcript.snapshot(), [question]);
  const firstState = [...storage.states.values()][0];
  assert.equal(modelReplyText(firstState.feedback.payload), 'answer 1', 'external feedback is already saved even though formal answer persistence failed');

  // Storage inspection proves the external fact; neither it nor observation is
  // used to manufacture a business retry reference for the original helper.
  rejectAnswer = false;
  assert.equal(await runner.run(question.content), 'answer 2');
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], [question, question], 'rerunning the root also appends a new user input');
  assert.deepEqual(transcript.snapshot(), [question, question, { role: 'assistant', content: 'answer 2' }]);
  assert.equal(storage.states.size, 2);
  assert.notEqual([...storage.states.values()][1].id, firstState.id, 'same text does not identify the previous interaction');
});

test('a fixed append in a new invocation does not deduplicate by the same interaction reference, position or content', async (t) => {
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send() {
      sends++;
      return modelReply('saved external answer');
    },
  });
  t.after(async () => {
    await interactions.settled();
    interactions.close();
  });
  // The host obtains the reference from start, before any answer persistence.
  const reference = interactions.bind(CompletionInteraction).start({ messages: [question] });
  await interactions.settled();
  const transcript = new Transcript();
  const runner = fixedAnswerWriter(interactions, transcript);
  const first = await runner.run(reference);
  const second = await runner.run(reference);

  assert.equal(sends, 1, 're-reading feedback does not send again');
  assert.equal(first.start, 0);
  assert.equal(second.start, 1);
  assert.deepEqual(transcript.snapshot(), [
    { role: 'assistant', content: 'saved external answer' },
    { role: 'assistant', content: 'saved external answer' },
  ]);
  const appends = transcript.exportState().appends;
  assert.equal(appends.length, 2);
  assert.equal(appends[0].request.operation.position, appends[1].request.operation.position);
  assert.deepEqual(appends[0].request.messages, appends[1].request.messages);
  assert.notEqual(appends[0].request.operation.parentContextId, appends[1].request.operation.parentContextId);
  assert.notEqual(appends[0].request.operation.childContextId, appends[1].request.operation.childContextId);
});

test('a lost persistence acknowledgement requires checking the stored revision instead of blindly replaying the append', async (t) => {
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send() {
      sends++;
      return modelReply('committed answer');
    },
  });
  t.after(async () => {
    await interactions.settled();
    interactions.close();
  });
  const reference = interactions.bind(CompletionInteraction).start({ messages: [question] });
  await interactions.settled();
  let stored;
  let loseAcknowledgement = true;
  const lostAcknowledgement = new PersistenceError('transcript.append', new Error('commit acknowledgement lost'));
  const staleRevision = new PersistenceError('transcript.append', new Error('stored revision differs'));
  const transcript = new Transcript([], {
    persistence: {
      commit(change) {
        if (change.expectedRevision !== stored.revision) throw staleRevision;
        assert.equal(change.kind, 'append');
        assert.equal(change.start, stored.messages.length);
        stored = structuredClone({ ...stored, revision: change.revision, messages: [...stored.messages, ...change.messages], appends: [...(stored.appends ?? []), change.fixed] });
        // Fault injection: storage committed, but its acknowledgement is lost.
        // This deliberately models an uncertain port outcome, not an ordinary
        // before-commit failure or an automatic recovery guarantee.
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw lostAcknowledgement;
        }
      },
    },
  });
  stored = structuredClone(transcript.exportState());
  const runner = fixedAnswerWriter(interactions, transcript);

  await assert.rejects(runner.run(reference), (error) => error === lostAcknowledgement);
  assert.equal(transcript.length, 0, 'the live entity cannot install an unacknowledged commit');
  assert.equal(transcript.revision, 0);
  assert.equal(stored.messages.length, 1, 'the external store may already contain the effect');
  assert.equal(stored.revision, 1);
  await assert.rejects(runner.run(reference), (error) => error === staleRevision);
  assert.equal(sends, 1);
  assert.equal(stored.messages.length, 1, 'revision comparison prevents a stale blind retry from duplicating the write');
  assert.equal(transcript.length, 0, 'the failed retry does not silently hydrate the entity');

  // Only an explicit authoritative read/hydration establishes what committed.
  const inspected = Transcript.restore(stored);
  assert.deepEqual(inspected.snapshot(), [{ role: 'assistant', content: 'committed answer' }]);
  assert.equal(inspected.exportState().appends.length, 1);
});
