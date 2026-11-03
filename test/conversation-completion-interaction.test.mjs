import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionInteraction, CompletionInteractionResource, CompletionResource, ConversationMemoryResource, ConversationViewResource, ModelReplyPending, createCompletionStartNode, createCompletionReplyNode, createConversationScene, createInteractionCompletion, createMaterialAnswer, createMaterialPreparation, createMemoryMaintenance, createMessageInclusion } from '@capix/conversation-service';
import { Interactions } from '@capix/interaction';
import { Memories, MemoryResource } from '@capix/memory';
import { ChatCompletionsProvider } from '@capix/model-provider';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Group, Node, Scene } from '@capix/structure';
import { Transcript, TranscriptResource } from '@capix/transcript';
import { View } from '@capix/view';

const request = () => ({
  messages: [
    { role: 'system', content: 'Use the supplied material.' },
    { role: 'user', content: 'question' },
  ],
  stream: true,
  responseFormat: 'text',
  temperature: 0.25,
  maxTokens: 1200,
});
const reply = (text = 'final answer', finishReason = 'stop') => ({ id: 'completion-1', model: 'fixture-model', text, finishReason, usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 } });
const preview = (outputs) => outputs.filter((event) => event.kind === 'delta').map((event) => event.delta);

function storage() {
  const states = new Map();
  return {
    states,
    create(state) {
      assert.equal(states.has(state.id), false);
      states.set(state.id, structuredClone(state));
    },
    commit({ expectedRevision, state }) {
      assert.equal(states.get(state.id).revision, expectedRevision);
      states.set(state.id, structuredClone(state));
    },
    read: (id) => states.get(id),
  };
}

function startRunner(interactions) {
  return new Runner(new Scene(createCompletionStartNode()), new Resources().registerInteraction(CompletionInteractionResource.start, CompletionInteraction), interactions).build();
}

function reader(interactions, waitMs = 1000) {
  const scene = new Scene({ output: { result: (value) => value, delta: (value) => value } }).add({ read: createCompletionReplyNode(waitMs) });
  scene.run = (work) => work.children.read.invoke(work.input, { delta: (value) => work.output.emit(value) });
  const runner = new Runner(scene, new Resources().registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction), interactions).build();
  const outputs = [];
  runner.output.subscribe({ receive: (event) => void outputs.push(event) });
  return { runner, outputs };
}

function materialConversation(interactions, { memoryModel, maintenance, waitMs = 1000 } = {}) {
  const transcript = new Transcript();
  const memories = new Memories(transcript);
  const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
  const content = new Resource({ transcript, memories, view });
  const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(content, ConversationViewResource.read).register(content, ConversationViewResource.manage).registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
  if (memoryModel) {
    const memory = new Resource(memories);
    resources.register(memory, ConversationMemoryResource).register(memory, MemoryResource.apply).register(new Resource(memoryModel), CompletionResource);
    maintenance = new Group().add({ include: createMessageInclusion(), remember: createMemoryMaintenance() });
    maintenance.run = async (work) => {
      await work.children.include.invoke(work.input);
      await work.children.remember.invoke(work.input);
    };
  }
  const scene = createConversationScene(createMaterialAnswer(createInteractionCompletion({ waitMs })), createMaterialPreparation(), maintenance);
  const runner = new Runner(scene, resources, interactions).build();
  const outputs = [];
  runner.output.subscribe({ receive: (event) => void outputs.push(event) });
  return { runner, transcript, memories, view, outputs };
}

test('completion exchange fixes system instructions and parameters and retains a complete reply across hosts', async () => {
  const persistence = storage();
  const finished = Promise.withResolvers();
  const sent = [];
  const interactions = new Interactions().register(CompletionInteraction, {
    persistence,
    send(value, { publish }) {
      sent.push(value);
      publish('preview');
      return finished.promise;
    },
  });
  const starter = startRunner(interactions);
  assert.equal(sent.length, 0, 'build must not dispatch');
  const original = request();
  const expected = structuredClone(original);
  const reference = await starter.run(original);
  assert.equal(reference.contract, CompletionInteraction.key);
  assert.ok(Object.isFrozen(reference));
  original.messages[0].content = 'changed after dispatch';
  original.temperature = 2;
  assert.deepEqual(sent, [expected]);
  assert.ok(Object.isFrozen(sent[0]) && Object.isFrozen(sent[0].messages) && Object.isFrozen(sent[0].messages[0]));
  const response = reply('different final wording');
  const expectedReply = structuredClone(response);
  finished.resolve(response);
  await interactions.settled();
  response.usage.totalTokens = 999;
  const current = reader(interactions);
  assert.deepEqual(await current.runner.run(reference), expectedReply);
  assert.deepEqual(preview(current.outputs), ['preview']);
  assert.deepEqual(persistence.read(reference.id).request, expected);
  assert.deepEqual(persistence.read(reference.id).feedback.payload, expectedReply);
  interactions.close();

  const restored = new Interactions().register(CompletionInteraction, {
    send: () => assert.fail('saved feedback must not resend'),
    persistence: { create: () => assert.fail('read cannot create'), commit: () => assert.fail('read cannot commit'), read: persistence.read },
  });
  const restoredReader = reader(restored, 0);
  assert.deepEqual(await restoredReader.runner.run(reference), expectedReply);
  assert.deepEqual(preview(restoredReader.outputs), [], 'a saved final reply does not manufacture a preview');
  assert.equal(restored.active, false);
  assert.equal(sent.length, 1);
  restored.close();
});

test('a formally returned reference survives local cancellation and a new invocation reads late full feedback', { timeout: 3000 }, async (t) => {
  const result = Promise.withResolvers();
  const firstPreview = Promise.withResolvers();
  let publish;
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send(_request, controls) {
      sends++;
      publish = controls.publish;
      publish('first');
      return result.promise;
    },
  });
  t.after(async () => {
    result.resolve(reply());
    await interactions.settled();
    interactions.close();
  });
  // This reference is the formal result of a real start Node, not recovered from observation.
  const reference = await startRunner(interactions).run(request());
  const current = reader(interactions);
  current.runner.output.subscribe({ receive: (event) => void (event.kind === 'delta' && firstPreview.resolve()) });
  const running = current.runner.run(reference);
  const stopped = assert.rejects(running, { code: 'INVOCATION_CANCELLED' });
  await firstPreview.promise;
  assert.equal(current.runner.cancel(), true);
  await stopped;
  assert.equal(current.runner.isRunning, false);
  assert.equal(interactions.active, true);
  publish(' late');
  result.resolve(reply('the complete late answer'));
  await interactions.settled();
  const next = reader(interactions);
  assert.deepEqual(await next.runner.run(structuredClone(reference)), reply('the complete late answer'));
  assert.deepEqual(preview(current.outputs), ['first']);
  assert.deepEqual(preview(next.outputs), ['first', ' late']);
  assert.equal(sends, 1);
});

test('wait-expired carries the original completion reference while unavailable feedback remains a failure', { timeout: 3000 }, async (t) => {
  const result = Promise.withResolvers();
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, { send: () => (++sends, result.promise) });
  t.after(async () => {
    result.resolve(reply());
    await interactions.settled();
    interactions.close();
  });
  const scene = new Scene(createInteractionCompletion({ waitMs: 0 }));
  const resources = new Resources().registerInteraction(CompletionInteractionResource.start, CompletionInteraction).registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction);
  const runner = new Runner(scene, resources, interactions).build();
  let pending;
  await assert.rejects(runner.run(request()), (error) => {
    pending = error;
    return error instanceof ModelReplyPending;
  });
  assert.ok(Object.isFrozen(pending.reference));
  assert.equal(pending.reference.contract, CompletionInteraction.key);
  result.resolve(reply());
  await interactions.settled();
  const reading = reader(interactions, 0);
  assert.deepEqual(await reading.runner.run(pending.reference), reply());
  await assert.rejects(reading.runner.run({ id: 'unknown', contract: CompletionInteraction.key }), (error) => !(error instanceof ModelReplyPending) && error.code === 'INTERACTION_UNKNOWN');
  assert.equal(sends, 1);
});

test('completion readers expose ordered cursors and can continue after a known position', async () => {
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send(_request, { publish }) {
      sends++;
      publish('one');
      publish('two');
      publish('three');
      return reply();
    },
  });
  const reference = await startRunner(interactions).run(request());
  await interactions.settled();
  const items = [];
  const follower = new Node({ deps: { feedback: CompletionInteractionResource.feedback.request() }, run: (work) => work.resources.feedback.follow(work.input, { delta: (item) => items.push(item) }) });
  const runner = new Runner(new Scene(follower), new Resources().registerInteraction(CompletionInteractionResource.feedback, CompletionInteraction), interactions).build();
  assert.equal((await runner.run({ reference, waitMs: 1000 })).kind, 'received');
  assert.deepEqual(
    items.map((item) => item.cursor.sequence),
    [1, 2, 3],
  );
  const cursor = items[0].cursor;
  items.length = 0;
  assert.deepEqual((await runner.run({ reference, after: cursor, waitMs: 1000 })).feedback.payload, reply());
  assert.deepEqual(
    items.map((item) => item.value),
    ['two', 'three'],
  );
  assert.equal(sends, 1);
  interactions.close();
});

test('pending readers keep the entered exchange identity when the caller mutates its input during waiting', { timeout: 3000 }, async (t) => {
  for (const variant of [{ name: 'complete reply', contract: CompletionInteraction, resources: CompletionInteractionResource, createReader: createCompletionReplyNode, input: request(), output: reply() }]) {
    await t.test(variant.name, async (t) => {
      const result = Promise.withResolvers();
      const following = Promise.withResolvers();
      let sends = 0;
      const interactions = new Interactions().register(variant.contract, {
        send: () => {
          sends++;
          return result.promise;
        },
      });
      t.after(async () => {
        result.resolve(variant.output);
        await interactions.settled();
        interactions.close();
      });
      const channel = interactions.bind(variant.contract);
      const first = channel.start(variant.input);
      const second = channel.start(variant.input);
      assert.notEqual(first.id, second.id);
      const mutableReference = { ...first };
      const runner = new Runner(new Scene(variant.createReader(100)), new Resources().registerInteraction(variant.resources.feedback, variant.contract), interactions).build();
      runner.observation.subscribe({
        receive(event) {
          if (event.source === 'resource' && event.fact.offerId === variant.resources.feedback.request().offer.id && event.fact.phase === 'started') following.resolve();
        },
      });
      const running = runner.run(mutableReference);
      const expired = assert.rejects(running, (error) => {
        assert.ok(error instanceof ModelReplyPending);
        assert.deepEqual(error.reference, first, 'pending must refer to the exchange actually awaited');
        assert.ok(Object.isFrozen(error.reference));
        return true;
      });
      // The resource-start fact confirms the reader has entered follow; do not guess from a sleep.
      await following.promise;
      mutableReference.id = second.id;
      await expired;
      assert.equal(runner.isRunning, false);
      assert.equal(interactions.active, true);
      assert.equal(channel.read(first).kind, 'pending');
      assert.equal(channel.read(second).kind, 'pending');
      assert.equal(sends, 2, 'reading and expiry must not send replacement requests');
    });
  }
});

test('invalid completion requests never send and invalid full replies never turn into pending', async (t) => {
  let sends = 0;
  const interactions = new Interactions().register(CompletionInteraction, {
    send: () => {
      sends++;
      return reply();
    },
  });
  const starter = startRunner(interactions);
  for (const invalid of [
    { ...request(), apiKey: 'not-part-of-the-request' },
    { ...request(), maxTokens: 0 },
    { ...request(), stream: 'yes' },
    { ...request(), responseFormat: 'xml' },
    { ...request(), messages: [{ role: 'tool', content: 'unsupported' }] },
  ]) {
    await assert.rejects(starter.run(invalid));
  }
  assert.equal(sends, 0);
  interactions.close();
  for (const invalid of [
    { ...reply(), usage: { promptTokens: -1, completionTokens: 0, totalTokens: 0 } },
    { ...reply(), finishReason: null },
    { ...reply(), unexpected: true },
  ]) {
    await t.test(JSON.stringify(invalid), async () => {
      let calls = 0;
      const owner = new Interactions().register(CompletionInteraction, {
        send: () => {
          calls++;
          return invalid;
        },
      });
      const reference = await startRunner(owner).run(request());
      await owner.settled();
      await assert.rejects(reader(owner).runner.run(reference), (error) => !(error instanceof ModelReplyPending));
      assert.equal(calls, 1);
      owner.close();
    });
  }
});

test('length and blank replies remain real exchange feedback but material business refuses to append them', async (t) => {
  for (const response of [reply('partial', 'length'), reply('   ')]) {
    await t.test(response.finishReason === 'length' ? 'length' : 'blank', async () => {
      const saved = storage();
      const roles = [];
      const interactions = new Interactions().register(CompletionInteraction, {
        persistence: saved,
        send(_request, { publish }) {
          publish('candidate');
          return response;
        },
      });
      const maintenance = new Node({
        run(work) {
          roles.push(work.input.message.role);
        },
      });
      const content = materialConversation(interactions, { maintenance });
      await assert.rejects(content.runner.run('question'));
      await interactions.settled();
      assert.deepEqual(content.transcript.snapshot(), [{ role: 'user', content: 'question' }]);
      assert.deepEqual(roles, ['user'], 'unaccepted replies cannot start assistant maintenance');
      assert.equal(content.outputs.at(-1).kind, 'discarded');
      const state = [...saved.states.values()][0];
      assert.deepEqual(state.feedback.payload, response, 'finish reason and blank text are not erased at the exchange boundary');
      assert.deepEqual(await reader(interactions).runner.run({ id: state.id, contract: state.contract }), response);
      interactions.close();
    });
  }
});

test('lost preview capacity does not hide valid full completion metadata or prevent business reception', async () => {
  const interactions = new Interactions().register(CompletionInteraction, {
    progress: { maxBytes: 1 },
    send(_request, { publish }) {
      publish('larger than one byte');
      return reply();
    },
  });
  const content = materialConversation(interactions);
  assert.equal(await content.runner.run('question'), 'final answer');
  assert.deepEqual(preview(content.outputs), []);
  assert.equal(content.transcript.get(1).content, 'final answer');
  await interactions.settled();
  interactions.close();
});

test('a material completion can use real provider SSE decoding while memory maintenance remains a separate direct request', async () => {
  const requests = [];
  let content;
  const provider = new ChatCompletionsProvider({
    endpoint: 'https://fixture.example/chat/completions',
    apiKey: 'fixture',
    model: 'fixture-model',
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (body.stream) {
        const material = JSON.parse(body.messages[1].content);
        assert.equal(body.messages[0].role, 'system');
        assert.equal(material.query.content, 'Remember concise replies');
        assert.equal(material.query.transcriptId, content.transcript.id);
        const chunks = [
          { id: 'sse-1', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
          { id: 'sse-1', model: 'fixture-model', choices: [{ index: 0, delta: { content: ' there' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } },
        ];
        return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
      }
      assert.equal(content.transcript.get(1).content, 'Hello there');
      assert.equal(
        content.outputs.some((event) => event.kind === 'completed'),
        false,
        'maintenance is still part of the Scene',
      );
      const input = JSON.parse(body.messages[1].content);
      assert.equal(input.acceptedIndex, 1);
      const text = JSON.stringify({ changes: [{ action: 'create', memoryId: null, change: 'Explicit preference', sourceIndexes: [0], result: { topic: 'style', content: 'Use concise replies', sourceIndexes: [0] } }] });
      return Response.json({ id: 'memory-1', model: 'fixture-model', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    },
  });
  const persisted = storage();
  const interactions = new Interactions().register(CompletionInteraction, {
    persistence: persisted,
    send: (value, { publish }) =>
      provider.complete(value, {
        emit: (delta) => {
          publish(delta);
        },
      }),
  });
  content = materialConversation(interactions, { memoryModel: provider });
  assert.equal(await content.runner.run('Remember concise replies'), 'Hello there');
  assert.deepEqual(preview(content.outputs), ['Hello', ' there']);
  assert.deepEqual(
    requests.map((value) => value.stream),
    [true, false],
  );
  assert.equal(content.memories.values().length, 1);
  assert.ok(content.view.has({ source: 'memories', key: content.memories.values()[0].id }));
  assert.equal(persisted.states.size, 1, 'memory extraction did not silently switch to independent interaction');
  const state = [...persisted.states.values()][0];
  assert.deepEqual(state.feedback.payload, { id: 'sse-1', model: 'fixture-model', text: 'Hello there', finishReason: 'stop', usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 } });
  await interactions.settled();
  interactions.close();
});
