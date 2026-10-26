import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProgressChannel } from '@capix/changes';
import { Resources, Runner } from '@capix/server-runtime';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { MessageUsage } from '@capix/measurement';
import { initializeObserver } from '@capix/observer-service/assembly';
import { ActiveView } from '@capix/observer-content';
import { createConversationStructure, ModelInteractions, ModelSource, registerConversationResources, ConversationCallCapture, conversationCallHooks } from '@capix/observer-service/conversation';

const settings = () => ({ model: 'initial-model', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 });
const input = (content) => ({ messages: [{ role: 'user', content }] });

function environment(t) {
  const requests = [];
  const value = initializeObserver({
    async invoke(request, purpose, _signal, progress) {
      requests.push({ purpose, request });
      const output = purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'streamed reply' };
      const content = JSON.stringify(output);
      if (purpose === 'answer') progress.publish({ text: content });
      return { id: 'fixture', model: request.model, content, finishReason: 'stop', usage: null };
    },
  });
  t.after(() => value.close());
  return { value, requests };
}

test('Observer Runner preserves one settings basis from input admission through model use and checkpoint registration', async (t) => {
  const { value, requests } = environment(t);
  assert.ok(value.runner instanceof Runner);
  assert.ok(value.resources instanceof Resources);
  const configuration = settings();
  let admitted = 0;
  const options = {
    settings: configuration,
    progress: new ProgressChannel({
      receive(event) {
        if (event.kind === 'input' && ++admitted === 1) configuration.model = 'next-model';
      },
    }),
  };

  await value.runner.run(input('first'), options);
  const [first] = value.checkpointRuns.list(value.conversationId);
  assert.equal(first.settings.model, 'initial-model', 'the saved recovery basis must describe the actual model request');
  assert.deepEqual(
    requests.map(({ request }) => request.model),
    ['initial-model', 'initial-model'],
  );
  assert.equal(configuration.model, 'next-model', 'the caller still owns its mutable settings object');
  assert.equal(Object.isFrozen(configuration), false);

  await value.runner.run(input('second'), options);
  const second = value.checkpointRuns.list(value.conversationId).find((run) => run.rootContextId !== first.rootContextId);
  assert.equal(second.settings.model, 'next-model');
  assert.deepEqual(
    requests.slice(2).map(({ request }) => request.model),
    ['next-model', 'next-model'],
  );
  assert.deepEqual([first.input.start, first.input.end, second.input.start, second.input.end], [0, 1, 2, 3]);
});

test('Observer Runner keeps progress, preview and necessary registration attached to the admitted call when caller options change', async (t) => {
  const { value } = environment(t);
  const current = { progress: [], answer: [], starts: [] };
  const next = { progress: [], answer: [], starts: [] };
  const nextProgress = new ProgressChannel({
    receive: (event) => {
      next.progress.push(event);
    },
  });
  const nextAnswer = new ProgressChannel({
    receive: (event) => {
      next.answer.push(event);
    },
  });
  const nextCallbacks = {
    started: (context) => {
      next.starts.push(context.id);
    },
  };
  const options = {
    settings: settings(),
    progress: new ProgressChannel({
      receive(event) {
        current.progress.push(event);
        if (event.kind === 'input') {
          options.progress = nextProgress;
          options.answerProgress = nextAnswer;
          options.executionCallbacks = nextCallbacks;
        }
      },
    }),
    answerProgress: new ProgressChannel({
      receive: (event) => {
        current.answer.push(event);
      },
    }),
    executionCallbacks: {
      started: (context) => {
        current.starts.push(context.id);
      },
    },
  };

  await value.runner.run(input('first'), options);
  assert.equal(current.starts.length, 1);
  assert.ok(current.progress.some((event) => event.kind === 'answer'));
  assert.ok(current.answer.some((event) => event.kind === 'committed'));
  assert.deepEqual(next, { progress: [], answer: [], starts: [] });
  const lengths = [current.progress.length, current.answer.length, current.starts.length];

  await value.runner.run(input('second'), options);
  assert.deepEqual([current.progress.length, current.answer.length, current.starts.length], lengths);
  assert.equal(next.starts.length, 1);
  assert.notEqual(next.starts[0], current.starts[0]);
  assert.ok(next.progress.some((event) => event.kind === 'answer'));
  assert.ok(next.answer.some((event) => event.kind === 'committed'));
  assert.equal(value.runner.isRunning, false);
  assert.equal(value.transcript.length, 4);
});

test('conversation registration fixes entity identities without freezing the caller assembly bag', async (t) => {
  const original = new Transcript();
  const memories = new Memories(original);
  const active = new ActiveView(original, memories);
  const entities = { transcript: original, memories, active, messageUsage: new MessageUsage() };
  const model = new ModelInteractions(
    new ModelSource({
      async invoke(request, purpose) {
        const output = purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'original world' };
        return { id: 'fixture', model: request.model, content: JSON.stringify(output), finishReason: 'stop', usage: null };
      },
    }),
  );
  t.after(() => model.close());
  const structure = createConversationStructure();
  const resources = new Resources();
  const capture = new ConversationCallCapture(structure.scene, entities);
  registerConversationResources(resources, structure, entities, model, capture);
  const runner = new Runner(structure.scene, resources, undefined, { validate: (options) => capture.validate(options), hooks: conversationCallHooks(structure, capture) }).build();

  const replacement = new Transcript();
  entities.transcript = replacement;
  entities.memories = new Memories(replacement);
  entities.active = new ActiveView(replacement, entities.memories);
  assert.equal(Object.isFrozen(entities), false);

  const result = await runner.run(input('accepted into original world'), { settings: settings() });
  assert.equal(result.content, 'original world');
  assert.equal(original.length, 2);
  assert.equal(replacement.length, 0, 'registered captures cannot silently switch to a different transcript');
  assert.deepEqual(
    active.capture().messages.map(({ index }) => index),
    [0, 1],
  );
});

test('separate resource and call registration rejects mixed conversation ownership before installing supply', () => {
  const transcript = new Transcript([{ role: 'user', content: 'same input' }]);
  const memories = new Memories(transcript);
  const entities = { transcript, memories, active: new ActiveView(transcript, memories), messageUsage: new MessageUsage() };
  const structure = createConversationStructure();
  const capture = new ConversationCallCapture(structure.scene, entities);
  const other = createConversationStructure();
  const resources = new Resources();
  const model = new ModelInteractions(
    new ModelSource({
      invoke() {
        throw new Error('No model call is permitted during registration');
      },
    }),
  );
  try {
    assert.throws(() => registerConversationResources(resources, other, entities, model, capture), /another scene/);
    assert.throws(() => conversationCallHooks(other, capture), /another scene/);
    for (const key of ['transcript', 'memories', 'active', 'messageUsage', 'files']) {
      assert.throws(() => registerConversationResources(resources, structure, { ...entities, [key]: {} }, model, capture), new RegExp(`different ${key} entity`));
    }
    assert.equal(resources.snapshot(structure.scene).registrations.length, 0);
    assert.equal(resources.snapshot(structure.scene).scopes.length, 0);
    assert.equal(registerConversationResources(resources, structure, entities, model, capture), undefined);
    assert.equal(conversationCallHooks(structure, capture).length, 2);
  } finally {
    model.close();
  }
});
