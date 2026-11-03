import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionResource, ConversationViewResource, createConversationScene, createMaterialAnswer, createMaterialPreparation } from '@capix/conversation-service';
import { Memories, MemoryViewSource } from '@capix/memory';
import { Resource } from '@capix/resources';
import { Resources, Runner, isInvocationCancelled } from '@capix/server-runtime';
import { Node, Scene } from '@capix/structure';
import { Transcript, TranscriptResource, TranscriptViewSource } from '@capix/transcript';
import { View } from '@capix/view';

const earlier = [
  { role: 'user', content: '请使用简短的中文。' },
  { role: 'assistant', content: '好的。' },
  { role: 'user', content: '安排周四复核，周五发布。' },
  { role: 'assistant', content: '周四复核完成后确认发布。' },
];
const reply = (text) => ({ id: 'offline', model: 'test', text, finishReason: 'stop', usage: null });

function fixture(transcript = new Transcript(earlier), ViewType = View) {
  const memories = new Memories(transcript);
  const [preference] = memories.apply([{ action: 'create', memoryId: null, change: '记录明确偏好', sourceIndexes: [0], result: { topic: '表达偏好', content: '使用简短的中文。', sourceIndexes: [0] } }]);
  const sources = { messages: new TranscriptViewSource(transcript), memories: new MemoryViewSource(memories) };
  const view = new ViewType({
    revision: 0,
    sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } },
    members: [
      { source: 'messages', key: 3 },
      { source: 'memories', key: preference.id },
      { source: 'messages', key: 0 },
    ],
  });
  return { transcript, memories, preference, sources, view };
}

function assemble(content, answer, model, material = content) {
  const resources = new Resources().register(new Resource(content.transcript), TranscriptResource.append).register(new Resource(material), ConversationViewResource);
  if (model) resources.register(new Resource(model), CompletionResource);
  return new Runner(createConversationScene(answer, createMaterialPreparation()), resources).build();
}

function select(content, members) {
  content.view.applySync(content.sources, { basis: content.view.indexSync(content.sources).basis, members });
}

test('material preparation preserves sparse message positions and memory provenance independently of the accepted query', async () => {
  const content = fixture();
  const received = [];
  const answer = new Node({
    run(work) {
      received.push(work.input);
      return '周四复核，周五发布。';
    },
  });
  const runner = assemble(content, answer);
  assert.equal(await runner.run('概括一下。'), '周四复核，周五发布。');

  const input = received[0];
  assert.deepEqual(input.query, { transcriptId: content.transcript.id, index: 4, content: '概括一下。' });
  assert.deepEqual(
    input.materials.entries.map(({ source, key }) => ({ source, key })),
    [
      { source: 'messages', key: 3 },
      { source: 'memories', key: content.preference.id },
      { source: 'messages', key: 0 },
    ],
  );
  assert.deepEqual(input.materials.entries[0].value, earlier[3]);
  assert.equal(input.materials.entries[1].value.id, content.preference.id);
  assert.deepEqual(input.materials.entries[1].value.sourceIndexes, [0]);
  assert.equal(input.materials.basis.sources.messages.id, content.transcript.id);
  assert.equal(input.materials.basis.sources.memories.id, content.memories.id);
  assert.equal(input.materials.basis.viewRevision, 0);
  assert.ok(Object.isFrozen(input) && Object.isFrozen(input.query));
  assert.ok(Object.isFrozen(input.materials) && Object.isFrozen(input.materials.entries));
  assert.ok(input.materials.entries.every((entry) => Object.isFrozen(entry) && Object.isFrozen(entry.value)));
  assert.deepEqual(content.transcript.snapshot().slice(-2), [
    { role: 'user', content: '概括一下。' },
    { role: 'assistant', content: '周四复核，周五发布。' },
  ]);
  assert.equal(content.view.exportState().members.length, 3, 'input and answer append do not implicitly change View membership');
});

test('an empty View still carries the independent accepted query and can produce a formal answer', async () => {
  const content = fixture();
  select(content, []);
  const requests = [];
  const runner = assemble(content, createMaterialAnswer(), {
    complete: async (request) => {
      requests.push(request);
      return reply('可以只根据当前问题回答。');
    },
  });
  assert.equal(await runner.run('介绍一下你支持的输入。'), '可以只根据当前问题回答。');
  assert.equal(requests.length, 1);
  const input = JSON.parse(requests[0].messages.find((message) => message.role === 'user').content);
  assert.deepEqual(input.query, { transcriptId: content.transcript.id, index: 4, content: '介绍一下你支持的输入。' });
  assert.deepEqual(input.materials.entries, []);
  assert.equal(input.materials.basis.sources.messages.id, content.transcript.id);
  assert.equal(input.materials.basis.sources.memories.id, content.memories.id);
  assert.equal(content.transcript.get(5).content, '可以只根据当前问题回答。');
  assert.deepEqual(content.view.exportState().members, []);
});

test('a View identity or scope mismatch cannot be silently rebound to the registered whole source', async (t) => {
  for (const mismatch of ['identity', 'scope']) {
    await t.test(mismatch, async () => {
      const content = fixture();
      const state = content.view.exportState();
      const messages = mismatch === 'identity' ? { id: new Transcript().id, scope: 'whole' } : { id: content.transcript.id, scope: 'keys:[0,3]' };
      content.view = new View({ ...state, sources: { ...state.sources, messages } });
      let answers = 0;
      const answer = new Node({
        run: () => {
          answers++;
          return 'must not execute';
        },
      });
      const runner = assemble(content, answer);
      await assert.rejects(runner.run('query'));
      assert.equal(answers, 0);
      assert.deepEqual(content.transcript.snapshot().slice(4), [{ role: 'user', content: 'query' }]);
      assert.deepEqual(content.view.exportState().sources.messages, messages);
      assert.equal(runner.isRunning, false);
    });
  }
});

test('a captured answer keeps its material while host selection and memory changes affect the next capture', { timeout: 5000 }, async () => {
  const content = fixture();
  const entered = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  const received = [];
  const answer = new Node({
    async run(work) {
      received.push(work.input);
      if (received.length === 1) {
        entered.resolve();
        await proceed.promise;
      }
      return `answer ${received.length}`;
    },
  });
  const runner = assemble(content, answer);
  const running = runner.run('first query');
  await entered.promise;
  const first = received[0];
  const before = JSON.stringify(first);
  content.memories.apply([{ action: 'update', memoryId: content.preference.id, change: '宿主修订偏好材料', sourceIndexes: [0], result: { topic: '表达偏好', content: '中文回答，并列出两项。', sourceIndexes: [0] } }]);
  select(content, [
    { source: 'messages', key: 2 },
    { source: 'memories', key: content.preference.id },
  ]);
  assert.equal(JSON.stringify(first), before);
  proceed.resolve();
  assert.equal(await running, 'answer 1');
  assert.equal(await runner.run('second query'), 'answer 2');

  assert.equal(first.materials.entries[1].value.content, '使用简短的中文。');
  assert.deepEqual(
    received[1].materials.entries.map(({ source, key }) => ({ source, key })),
    [
      { source: 'messages', key: 2 },
      { source: 'memories', key: content.preference.id },
    ],
  );
  assert.equal(received[1].materials.entries[1].value.content, '中文回答，并列出两项。');
  assert.equal(received[1].materials.basis.viewRevision, 1);
  assert.notEqual(received[1].materials.basis.sources.memories.version, first.materials.basis.sources.memories.version);
  assert.equal(received[1].query.index, 6);
  assert.equal(content.transcript.get(3).content, earlier[3].content, 'leaving the View does not remove formal content');
});

test('current and later messages selected by the host are not passed off as earlier material', async () => {
  const content = fixture();
  content.transcript.append({ role: 'user', content: 'this query' }, { role: 'user', content: 'later host message' });
  select(content, [
    { source: 'messages', key: 3 },
    { source: 'messages', key: 4 },
    { source: 'messages', key: 5 },
    { source: 'memories', key: content.preference.id },
  ]);
  const resources = new Resources().register(new Resource(content), ConversationViewResource);
  const runner = new Runner(new Scene(createMaterialPreparation()), resources).build();
  const received = await runner.run({ transcriptId: content.transcript.id, index: 4, message: content.transcript.get(4) });
  assert.equal(received.query.index, 4);
  assert.equal(received.query.content, 'this query');
  assert.deepEqual(
    received.materials.entries.filter((entry) => entry.source === 'messages').map((entry) => entry.key),
    [3],
  );
  assert.equal(content.transcript.get(5).content, 'later host message');
});

test('a source change during capture fails once without executing the answer or pretending to have one coherent snapshot', async () => {
  let content;
  let captures = 0;
  let answers = 0;
  class ConflictingView extends View {
    async capture(sources, index) {
      captures++;
      const basis = index ?? (await this.index(sources));
      content.transcript.append({ role: 'user', content: 'concurrent content' });
      return super.capture(sources, basis);
    }
  }
  content = fixture(undefined, ConflictingView);
  const answer = new Node({
    run: () => {
      answers++;
      return 'must not execute';
    },
  });
  const runner = assemble(content, answer);
  await assert.rejects(runner.run('query'));
  assert.equal(captures, 1);
  assert.equal(answers, 0);
  assert.equal(runner.isRunning, false);
  assert.deepEqual(content.transcript.snapshot().slice(4), [
    { role: 'user', content: 'query' },
    { role: 'user', content: 'concurrent content' },
  ]);
});

test('equal text in another transcript cannot substitute for the accepted input source', async () => {
  const content = fixture();
  const other = fixture();
  let answers = 0;
  const answer = new Node({
    run: () => {
      answers++;
      return 'must not execute';
    },
  });
  const runner = assemble(content, answer, undefined, other);
  await assert.rejects(runner.run('query'));
  assert.equal(answers, 0);
  assert.equal(content.transcript.length, 5);
  assert.equal(other.transcript.length, 4);
});

test('material sources cannot associate a memory collection with a different transcript', async () => {
  const content = fixture();
  const other = fixture();
  let answers = 0;
  const answer = new Node({
    run: () => {
      answers++;
      return 'must not execute';
    },
  });
  await assert.rejects(async () => {
    const runner = assemble(content, answer, undefined, { ...content, memories: other.memories });
    await runner.run('query');
  });
  assert.equal(answers, 0);
});

test('the default material answer sends typed source material to the model and accepts only the saved answer', async () => {
  const content = fixture();
  const requests = [];
  const runner = assemble(content, createMaterialAnswer(), {
    complete: async (request) => {
      requests.push(request);
      return reply('完整回答。');
    },
  });
  assert.equal(await runner.run('query'), '完整回答。');
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].messages.find((message) => message.role === 'user').content);
  assert.deepEqual(payload.query, { transcriptId: content.transcript.id, index: 4, content: 'query' });
  assert.equal(payload.materials.entries.find((entry) => entry.source === 'memories').value.id, content.preference.id);
  assert.equal(content.transcript.get(5).content, '完整回答。');
  assert.deepEqual(
    content.transcript.snapshot().map((message) => message.role),
    ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
  );
});

test('answer persistence failure keeps the accepted query without publishing a completed scene result', async () => {
  let rejectAssistant = false;
  const transcript = new Transcript(earlier, {
    persistence: {
      commit(change) {
        if (rejectAssistant && change.kind === 'append' && change.messages.some((message) => message.role === 'assistant')) throw new Error('cannot save answer');
      },
    },
  });
  const content = fixture(transcript);
  rejectAssistant = true;
  const completed = [];
  const runner = assemble(content, createMaterialAnswer(), { complete: async () => reply('unsaved answer') });
  runner.output.subscribe({
    receive: (event) => {
      if (event.kind === 'completed') completed.push(event.result);
    },
  });
  await assert.rejects(runner.run('query'));
  assert.equal(transcript.length, 5);
  assert.deepEqual(transcript.get(4), { role: 'user', content: 'query' });
  assert.deepEqual(completed, []);
  assert.equal(runner.isRunning, false);
});

test('cancellation during material answering stops this call without appending the model candidate', { timeout: 5000 }, async () => {
  const content = fixture();
  const entered = Promise.withResolvers();
  const controller = new AbortController();
  const runner = assemble(content, createMaterialAnswer(), {
    complete: async (_request, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        entered.resolve();
      }),
  });
  const running = runner.run('query', { signal: controller.signal });
  const rejected = assert.rejects(running, (error) => isInvocationCancelled(error, controller.signal));
  await entered.promise;
  controller.abort(new Error('cancel this call'));
  await rejected;
  assert.equal(content.transcript.length, 5);
  assert.equal(runner.isRunning, false);
});
