import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Driver, MemoryCheckpointStore, ProgressChannel } from '@capix/server-runtime';
import { Transcript, Memories, SelectionUsage } from '@capix/server-runtime/content';
import { ActiveContent, bindConversation, ConversationSceneDefinition, ModelInteractions, ModelSource } from '@capix/observer-service/conversation';
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
  const checkpointStore = new MemoryCheckpointStore();
  const capabilities = { conversationId: 'conversation', checkpointRuns: new MemoryConversationCheckpointRuns() };
  const driver = new Driver({ checkpoints: { store: checkpointStore } });
  const scene = bindConversation(driver, new ConversationSceneDefinition(), entities, model, capabilities);
  return { driver, scene, entities, model, capabilities, requests };
}

test('conversation checkpoint association requires the Driver to install the store', (t) => {
  const { entities, model, capabilities } = binding();
  t.after(() => model.close());
  assert.throws(() => bindConversation(new Driver(), new ConversationSceneDefinition(), entities, model, capabilities), /Checkpoint run association requires a conversation and checkpoint store/);
});

test('conversation source resets capture for reused options and registers CP before external started', async (t) => {
  const { driver, scene, entities, model, capabilities, requests } = binding();
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
  await driver.run(scene, { messages: [{ role: 'user', content: 'first' }] }, options);
  await driver.run(scene, { messages: [{ role: 'user', content: 'second' }] }, options);
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
  const { driver, scene, entities, model, capabilities } = binding();
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
  await assert.rejects(driver.run(scene, { messages: [{ role: 'user', content: 'admitted only' }] }, options), /host start callback failed/);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['input'],
  );
  assert.equal(capabilities.checkpointRuns.list('conversation').length, 1);
  options.progress = undefined;
  options.executionCallbacks = undefined;
  await driver.run(scene, { messages: [{ role: 'user', content: 'new request' }] }, options);
  const run = capabilities.checkpointRuns.list('conversation').at(-1);
  assert.deepEqual(run.input, { transcriptId: entities.transcript.id, start: 1, end: 2, revision: 2 });
  assert.equal(run.transcript.end, 2);
  assert.equal(entities.transcript.length, 3);
  assert.deepEqual(
    events.map((event) => event.kind),
    ['input'],
  );
});

test('conversation source preserves async host setup failure instead of starting model work', async (t) => {
  const { driver, scene, entities, model, capabilities, requests } = binding();
  t.after(() => model.close());
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let finished = false;
  try {
    await assert.rejects(
      driver.run(
        scene,
        { messages: [{ role: 'user', content: 'accepted input' }] },
        {
          settings,
          executionCallbacks: {
            async started(context, invocation) {
              const registered = capabilities.checkpointRuns.read('conversation', invocation.identity.parentContextId);
              assert.equal(registered.executionContextId, context.id);
              await pending;
              finished = true;
              throw new Error('late host setup failure');
            },
          },
        },
      ),
      /started callbacks must return undefined synchronously/,
    );
    assert.equal(finished, false);
    assert.equal(requests.length, 0);
    assert.equal(entities.transcript.length, 1);
    assert.equal(capabilities.checkpointRuns.list('conversation').length, 1);
    assert.equal(driver.isRunning(scene), false);
  } finally {
    release();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, true);
  await driver.run(scene, { messages: [{ role: 'user', content: 'next input' }] }, { settings });
  assert.equal(entities.transcript.length, 3);
  assert.equal(requests.length, 2);
});

test('conversation binding rechecks registered restoration configuration without relying on host admission', async (t) => {
  const { driver, scene, entities, model, capabilities, requests } = binding();
  t.after(() => model.close());
  await driver.run(scene, { messages: [{ role: 'user', content: 'original' }] }, { settings });
  const [run] = capabilities.checkpointRuns.list('conversation');
  const changed = bindConversation(driver, new ConversationSceneDefinition({ maxDecisionSteps: 4 }), entities, model, capabilities);
  await assert.rejects(driver.run(changed, { messages: [{ role: 'user', content: 'must not append' }] }, { settings, checkpointRun: run }), { code: 'CHECKPOINT_CONFIGURATION_CHANGED' });
  assert.equal(entities.transcript.length, 2);
  assert.equal(requests.length, 2);
  assert.equal(driver.isRunning(changed), false);
});
