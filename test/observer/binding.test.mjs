import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCheckpointStore, ProgressChannel } from '@capix/server-runtime';
import { Transcript, Memories, SelectionUsage } from '@capix/server-runtime/content';
import { ActiveContent, bindConversation, ConversationRuntimeDefinition, ModelInteractions, ModelSource } from '@capix/observer-service/conversation';
import { MemoryConversationCheckpointRuns } from '@capix/observer-service/assembly';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };

function binding() {
  const requests = [];
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  const entities = { transcript, memories, active: new ActiveContent(transcript, memories), selectionUsage: new SelectionUsage() };
  const model = new ModelInteractions(
    new ModelSource({
      async invoke(request, purpose) {
        requests.push({ request, purpose });
        const value = purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: 'reply' } : { memories: [] };
        return { id: 'fixture', model: request.model, content: JSON.stringify(value), finishReason: 'stop', usage: null };
      },
    }),
  );
  const capabilities = { conversationId: 'conversation', checkpoints: { store: new MemoryCheckpointStore() }, checkpointRuns: new MemoryConversationCheckpointRuns() };
  const runtime = bindConversation(new ConversationRuntimeDefinition(), entities, model, capabilities);
  return { runtime, entities, model, capabilities, requests };
}

test('conversation source resets capture for reused options and registers CP before external started', async (t) => {
  const { runtime, entities, model, capabilities, requests } = binding();
  t.after(() => model.close());
  const starts = [];
  const options = {
    settings,
    executionCallbacks: {
      started(context, invocation) {
        const run = capabilities.checkpointRuns.read('conversation', invocation.identity.parentContextId);
        assert.equal(run.executionContextId, context.id);
        starts.push(run);
      },
    },
  };
  await runtime.run({ messages: [{ role: 'user', content: 'first' }] }, options);
  await runtime.run({ messages: [{ role: 'user', content: 'second' }] }, options);
  assert.deepEqual(
    starts.map((run) => [run.input.start, run.input.end, run.transcript.end]),
    [
      [0, 1, 1],
      [2, 3, 3],
    ],
  );
  assert.notEqual(starts[0].rootContextId, starts[1].rootContextId);
  assert.equal(entities.transcript.length, 4);
  assert.equal(requests.length, 4);
});

test('a failed execution start cannot leak its input capture or progress channel into the next call', async (t) => {
  const { runtime, entities, model, capabilities } = binding();
  t.after(() => model.close());
  const events = [];
  const options = {
    settings,
    progress: new ProgressChannel({
      receive: (event) => {
        events.push(event);
      },
    }),
    executionCallbacks: {
      started: () => {
        throw new Error('host start callback failed');
      },
    },
  };
  await assert.rejects(runtime.run({ messages: [{ role: 'user', content: 'admitted only' }] }, options), /host start callback failed/);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['input'],
  );
  assert.equal(capabilities.checkpointRuns.list('conversation').length, 1);
  options.progress = undefined;
  options.executionCallbacks = undefined;
  await runtime.run({ messages: [{ role: 'user', content: 'new request' }] }, options);
  const run = capabilities.checkpointRuns.list('conversation').at(-1);
  assert.deepEqual(run.input, { transcriptId: entities.transcript.id, start: 1, end: 2, revision: 2 });
  assert.equal(run.transcript.end, 2);
  assert.equal(entities.transcript.length, 3);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['input'],
  );
});

test('conversation binding rechecks registered restoration configuration without relying on host admission', async (t) => {
  const { runtime, entities, model, capabilities, requests } = binding();
  t.after(() => model.close());
  await runtime.run({ messages: [{ role: 'user', content: 'original' }] }, { settings });
  const [run] = capabilities.checkpointRuns.list('conversation');
  const changed = bindConversation(new ConversationRuntimeDefinition({ maxDecisionSteps: 4 }), entities, model, capabilities);
  await assert.rejects(changed.run({ messages: [{ role: 'user', content: 'must not append' }] }, { settings, checkpointRun: run }), { code: 'CHECKPOINT_CONFIGURATION_CHANGED' });
  assert.equal(entities.transcript.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(changed.running, false);
});
