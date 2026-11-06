import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionResource, ConversationMemoryResource, ConversationViewResource, createConversationScene, createMaterialAnswer, createMaterialPreparation, createMemoryMaintenance } from '@capix/conversation-service';
import { PersistenceError } from '@capix/diagnostics';
import { Memories, MemoryResource } from '@capix/memory';
import { ChatCompletionsProvider } from '@capix/model-provider';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Transcript, TranscriptResource } from '@capix/transcript';
import { View } from '@capix/view';

const reply = (text, finishReason = 'stop') => ({ id: 'completion', model: 'offline', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: finishReason === 'stop' ? 'completed' : 'incomplete', reason: finishReason }, usage: null });
const deltas = (events) => events.filter((event) => event.kind === 'delta').map((event) => event.delta);
const completed = (events) => events.filter((event) => event.kind === 'completed');
const proposal = (index = 0) => ({ changes: [{ action: 'create', memoryId: null, change: 'Preserve the request', sourceIndexes: [index], result: { topic: 'Preference', content: 'Use concise Chinese', sourceIndexes: [index] } }] });

function fixture(messages = [], options = {}) {
  const transcript = new Transcript(messages, options);
  const memories = new Memories(transcript);
  const view = new View({ revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: messages.length ? [{ source: 'messages', key: 0 }] : [] });
  return { transcript, memories, view };
}

function assemble(content, model) {
  const material = new Resource(content);
  const memory = new Resource(content.memories);
  const resources = new Resources().register(new Resource(content.transcript), TranscriptResource.append).register(material, ConversationViewResource.read).register(material, ConversationViewResource.manage).register(memory, ConversationMemoryResource).register(memory, MemoryResource.apply).register(new Resource(model), CompletionResource);
  const scene = createConversationScene(createMaterialAnswer(), createMaterialPreparation(), createMemoryMaintenance());
  const runner = new Runner(scene, resources).build();
  const outputs = [];
  const observations = [];
  runner.output.subscribe({ receive: (event) => void outputs.push(event) });
  runner.observation.subscribe({ receive: (event) => void observations.push(event) });
  return { runner, outputs, observations };
}

test('SSE model deltas reach the material Scene before final answer storage and memory extraction', { timeout: 5000 }, async () => {
  const content = fixture([
    { role: 'user', content: '请用简短中文。' },
    { role: 'assistant', content: '好的。' },
  ]);
  const fetched = Promise.withResolvers();
  const preview = Promise.withResolvers();
  const requests = [];
  let upstream;
  const model = new ChatCompletionsProvider({
    endpoint: 'https://fixture.example/chat/completions',
    apiKey: 'fixture-key',
    model: 'offline',
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (body.stream) {
        const stream = new ReadableStream({
          start(controller) {
            upstream = controller;
            fetched.resolve();
          },
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      assert.equal(body.response_format.type, 'json_object');
      assert.equal(content.transcript.get(3).content, '你好，已记住。', 'extraction starts only after the final answer is stored');
      assert.equal(completed(outputs).length, 0, 'the Scene is still waiting for maintenance');
      return Response.json({ id: 'memory-completion', model: 'offline', choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(proposal(2)) }, finish_reason: 'stop' }], usage: null });
    },
  });
  const { runner, outputs } = assemble(content, model);
  runner.output.subscribe({
    receive(event) {
      if (event.kind === 'delta') preview.resolve();
    },
  });
  const running = runner.run('记住这个偏好。');
  await fetched.promise;
  const material = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(material.query, { transcriptId: content.transcript.id, index: 2, content: '记住这个偏好。' });
  assert.equal(material.materials.entries[0].key, 0);
  assert.equal(material.materials.basis.sources.messages.id, content.transcript.id);
  const send = (value) => upstream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'answer-completion', model: 'offline', choices: [value] })}\n\n`));
  send({ index: 0, delta: { role: 'assistant', content: '你好' }, finish_reason: null });
  await preview.promise;
  assert.deepEqual(deltas(outputs), ['你好']);
  assert.equal(content.transcript.length, 3);
  assert.equal(content.memories.values().length, 0);
  assert.equal(requests.length, 1);
  assert.equal(completed(outputs).length, 0);

  send({ index: 0, delta: { content: '，已记住。' }, finish_reason: null });
  send({ index: 0, delta: {}, finish_reason: 'stop' });
  upstream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
  upstream.close();
  assert.equal(await running, '你好，已记住。');
  assert.deepEqual(deltas(outputs), ['你好', '，已记住。']);
  assert.equal(completed(outputs).length, 1);
  assert.equal(completed(outputs)[0].result, '你好，已记住。');
  assert.deepEqual(
    requests.map((request) => request.stream),
    [true, false],
  );
  assert.deepEqual(requests[0].stream_options, { include_usage: true });
  const [memory] = content.memories.values();
  assert.deepEqual(memory.sourceIndexes, [2]);
  assert.equal(content.view.has({ source: 'memories', key: memory.id }), true);
  assert.equal(runner.isRunning, false);
});

test('final material answer is authoritative and extraction has no preview publisher', async () => {
  const content = fixture();
  const requests = [];
  const model = {
    async complete(request, controls) {
      requests.push(request);
      if (request.stream) {
        controls.emit('draft wording');
        return reply('  revised final answer\n');
      }
      assert.equal(controls.emit, undefined, 'JSON extraction does not get the answer preview publisher');
      assert.equal(content.transcript.get(1).content, '  revised final answer\n');
      return reply(JSON.stringify({ changes: [] }));
    },
  };
  const { runner, outputs } = assemble(content, model);
  assert.equal(await runner.run('question'), '  revised final answer\n');
  assert.deepEqual(deltas(outputs), ['draft wording']);
  assert.equal(completed(outputs)[0].result, '  revised final answer\n');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].stream, true);
  assert.equal(requests[1].stream, undefined);
  assert.deepEqual(content.transcript.snapshot(), [
    { role: 'user', content: 'question' },
    { role: 'assistant', content: '  revised final answer\n' },
  ]);
});

test('a streamed answer waits for maintenance and is delivered after the proposal exception is handled', { timeout: 5000 }, async () => {
  const content = fixture();
  const extracting = Promise.withResolvers();
  const result = Promise.withResolvers();
  let calls = 0;
  const { runner, outputs, observations } = assemble(content, {
    complete(request, controls) {
      calls++;
      if (request.stream) {
        controls.emit('answer');
        return Promise.resolve(reply('answer'));
      }
      assert.equal(controls.emit, undefined);
      extracting.resolve();
      return result.promise;
    },
  });
  const running = runner.run('question');
  await extracting.promise;
  assert.deepEqual(deltas(outputs), ['answer']);
  assert.equal(content.transcript.get(1).content, 'answer');
  assert.equal(runner.isRunning, true);
  assert.equal(completed(outputs).length, 0);
  result.reject(new Error('extractor unavailable'));
  assert.equal(await running, 'answer');
  assert.equal(completed(outputs).length, 1);
  assert.equal(calls, 2, 'the failed extraction is not retried');
  assert.equal(content.memories.values().length, 0);
  const proposalId = observations.find((event) => event.source === 'invocation' && event.fact.kind === 'started' && event.fact.description?.name === 'propose-conversation-memories').fact.identity.contextId;
  const relations = observations.filter((event) => event.source === 'invocation' && event.fact.kind === 'relation' && event.fact.relation.childContextId === proposalId);
  assert.equal(relations.find((event) => event.fact.phase === 'returned').fact.status, 'failed');
  assert.ok(relations.some((event) => event.fact.phase === 'handled'));
});

test('failed or unacceptable final replies discard material preview without saving an answer or extracting memory', async (t) => {
  for (const kind of ['length', 'blank', 'transport failure']) {
    await t.test(kind, async () => {
      const content = fixture();
      let calls = 0;
      const { runner, outputs } = assemble(content, {
        async complete(request, { emit }) {
          calls++;
          assert.equal(request.stream, true);
          emit('unfinished preview');
          if (kind === 'transport failure') throw new Error('stream interrupted');
          return reply(kind === 'blank' ? ' \n' : 'partial', kind === 'length' ? 'length' : 'stop');
        },
      });
      await assert.rejects(runner.run('question'));
      assert.deepEqual(deltas(outputs), ['unfinished preview']);
      assert.equal(completed(outputs).length, 0);
      assert.equal(outputs.at(-1).kind, 'discarded');
      assert.deepEqual(content.transcript.snapshot(), [{ role: 'user', content: 'question' }]);
      assert.equal(content.memories.values().length, 0);
      assert.equal(calls, 1);
      assert.equal(runner.isRunning, false);
    });
  }
});

test('non-text material preview fails at the resource boundary even without an output subscriber', async () => {
  const content = fixture();
  const model = {
    async complete(_request, { emit }) {
      emit({ content: 'invalid preview' });
      return reply('answer');
    },
  };
  const material = new Resource(content);
  const resources = new Resources().register(new Resource(content.transcript), TranscriptResource.append).register(material, ConversationViewResource.read).register(new Resource(model), CompletionResource);
  const runner = new Runner(createConversationScene(createMaterialAnswer(), createMaterialPreparation()), resources).build();
  await assert.rejects(runner.run('question'));
  assert.deepEqual(content.transcript.snapshot(), [{ role: 'user', content: 'question' }]);
});

test('cancelling a material stream rejects late output and preserves the saved user input only', { timeout: 5000 }, async () => {
  const content = fixture();
  const entered = Promise.withResolvers();
  let publish;
  let calls = 0;
  const { runner, outputs, observations } = assemble(content, {
    complete(_request, { signal, emit }) {
      calls++;
      publish = emit;
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        emit('partial');
        entered.resolve();
      });
    },
  });
  const running = runner.run('question');
  const rejected = assert.rejects(running, { code: 'INVOCATION_CANCELLED' });
  await entered.promise;
  assert.equal(runner.cancel(new Error('stop')), true);
  await rejected;
  assert.throws(() => publish('late'));
  assert.deepEqual(deltas(outputs), ['partial']);
  assert.equal(completed(outputs).length, 0);
  assert.deepEqual(content.transcript.snapshot(), [{ role: 'user', content: 'question' }]);
  assert.equal(content.memories.values().length, 0);
  assert.equal(calls, 1);
  assert.equal(observations.findLast((event) => event.source === 'entry' && event.fact.kind === 'settled').fact.status, 'cancelled');
  assert.equal(runner.isRunning, false);
});

test('an answer persistence failure after preview never starts memory extraction', async () => {
  const content = fixture([], {
    persistence: {
      commit(change) {
        if (change.kind === 'append' && change.messages.some((message) => message.role === 'assistant')) throw new Error('answer save failed');
      },
    },
  });
  let calls = 0;
  const { runner, outputs } = assemble(content, {
    async complete(_request, { emit }) {
      calls++;
      emit('answer preview');
      return reply('answer');
    },
  });
  await assert.rejects(runner.run('question'), (error) => error instanceof PersistenceError);
  assert.deepEqual(deltas(outputs), ['answer preview']);
  assert.equal(completed(outputs).length, 0);
  assert.deepEqual(content.transcript.snapshot(), [{ role: 'user', content: 'question' }]);
  assert.equal(content.memories.values().length, 0);
  assert.equal(calls, 1);
});

test('the material model publisher expires after completion and later calls get a new publisher', async () => {
  const content = fixture();
  const publishers = [];
  const { runner, outputs } = assemble(content, {
    async complete(request, controls) {
      if (!request.stream) return reply('{"changes":[]}');
      publishers.push(controls.emit);
      controls.emit(`preview ${publishers.length}`);
      return reply(`answer ${publishers.length}`);
    },
  });
  assert.equal(await runner.run('first'), 'answer 1');
  const count = outputs.length;
  assert.throws(() => publishers[0]('late'));
  assert.equal(outputs.length, count);
  assert.equal(await runner.run('second'), 'answer 2');
  assert.notEqual(publishers[0], publishers[1]);
  assert.deepEqual(deltas(outputs), ['preview 1', 'preview 2']);
});
