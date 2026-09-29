import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '@capix-observer/client-runtime';
import { initializeObserver, acceptExecutionInput, observeExecution, observeOverview } from '@capix-observer/service';
import { Transcript, observeMemory } from '@capix-observer/runtime';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { deferred, snapshot, transport, deliverAnswer } from '../client/fixtures.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const withObservation = (io) => new ClientRuntime({ conversation: io, observation: io });

const request = { messages: [{ role: 'user', content: '上海，周末去' }] };
const history = [
  { role: 'user', content: '计划去旅行' },
  { role: 'assistant', content: '去哪里？' },
];
const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1024, timeoutMs: 1000 };
const raw = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });

async function recordedRound() {
  const snapshots = [];
  const environment = initializeObserver({ invoke: async (_request, purpose) => raw(purpose === 'selection' ? { historyIndexes: [0, 1] } : purpose === 'answer' ? { kind: 'answer', content: '上海周末行程。' } : { memories: [{ action: 'create', memoryId: null, change: '确认目的地', sourceIndexes: [2], result: { topic: '旅行', content: '周末去上海', sourceIndexes: [2] } }] }) }, new Transcript(history).snapshot());
  const input = acceptExecutionInput(environment.transcript, request);
  const final = await observeExecution(environment.execution, environment.recording, input, { settings, transcript: environment.transcript }, (value) => snapshots.push(value));
  return { snapshots, final, overview: observeOverview(environment), messages: environment.transcript.snapshot(), memory: observeMemory(environment.runtime.memories, environment.book) };
}

test('binding interprets live records, reconciles once, and keeps raw runtime separate from application models', async () => {
  const fixture = await recordedRound();
  const gate = deferred();
  let observe;
  let deliver;
  let accept;
  let finished = false;
  let detailReads = 0;
  const runtime = withObservation(
    transport({
      overview: async () => (finished ? fixture.overview : { messages: history.map((message, index) => ({ index, message, count: 0 })), executions: [] }),
      transcript: async () => ({ messages: finished ? fixture.messages : history }),
      memory: async () => (finished ? fixture.memory : { items: [] }),
      execution: async () => {
        detailReads++;
        return fixture.final;
      },
      observe: async (next, signal) => {
        observe = next;
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      run: async (_request, next, accepted) => {
        deliver = next;
        accept = accepted;
        await gate.promise;
        finished = true;
      },
    }),
  );
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  await settle();
  assert.equal(detailReads, 0);
  app.store.getState().setSearch('上海');
  app.store.getState().setDraft(request.messages[0].content);
  const submitting = app.commands.submit();
  assert.equal(app.store.getState().data.pending, request.messages[0].content);
  accept();
  deliverAnswer(deliver, 2, fixture.final.execution.contextId, '上海周末行程。');
  for (const value of fixture.snapshots) observe(value);
  const id = fixture.final.execution.id;
  const data = app.store.getState().data;
  assert.equal(runtime.getSnapshot().observation.overview.executions.length, 0, 'runtime does not build live overview');
  assert.equal(runtime.getSnapshot().observation.records.get(id), fixture.final);
  assert.equal(data.rounds[0].context.selectedCount, 2);
  assert.deepEqual(
    data.rounds[0].context.selectedMessages.map((item) => item.entry.count),
    [1, 1],
  );
  assert.equal(data.conversation.at(-1).message.content, '上海周末行程。');
  assert.equal(app.store.getState().matches[0].executionId, id);
  const answer = [...data.details.get(id).calls.values()].find((call) => call.operation === 'answer');
  assert.equal(answer.children.length, 4);
  assert.equal(answer.output.content, '上海周末行程。');
  gate.resolve();
  await submitting;
  await settle();
  assert.equal(runtime.getSnapshot().observation.updates.size, 0);
  assert.equal(app.store.getState().data.conversation.length, 4, 'formal reconciliation does not duplicate the observed answer');
  assert.equal(app.store.getState().data.details.get(id).memory.changes.length, 1);
  assert.deepEqual(
    app.store.getState().data.rounds[0].context.selectedMessages.map((item) => item.entry.count),
    [1, 1],
    'reconciliation does not double count',
  );
  const observed = runtime.getSnapshot();
  const stable = app.store.getState().data;
  app.store.getState().setDraft('只编辑');
  app.store.getState().setSearch('周末');
  assert.equal(runtime.getSnapshot(), observed);
  assert.equal(app.store.getState().data, stable);
  disconnect();
});

test('binding remount retains business messages despite unavailable observation', async () => {
  const fixture = await recordedRound();
  let finished = false;
  const io = transport({
    overview: async () => {
      if (finished) throw new Error('概览刷新失败');
      return { messages: [], executions: [] };
    },
    transcript: async () => ({ messages: finished ? fixture.messages : history }),
    execution: async () => fixture.final,
    run: async (_request, receive, accepted) => {
      accepted();
      deliverAnswer(receive, 2, fixture.final.execution.contextId, '上海周末行程。');
      finished = true;
    },
  });
  const runtime = withObservation(io);
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  await app.commands.loadExecution(fixture.final.execution.id);
  app.store.getState().setBudget('8192');
  disconnect();
  const before = app.store.getState().data;
  await runtime.submit(request);
  assert.equal(app.store.getState().data, before);
  const reconnect = app.connect();
  await settle();
  assert.equal(app.store.getState().budget, '8192');
  assert.equal(app.store.getState().data.conversation.at(-1).message.content, '上海周末行程。');
  assert.equal(app.store.getState().data.details.get(fixture.final.execution.id).answer, '上海周末行程。');
  assert.ok(app.store.getState().data.observationError);
  assert.equal(app.store.getState().notice, '');
  reconnect();
});

test('loading old detail records does not replace a fresh server overview or repeat selection counts', async () => {
  const fixture = await recordedRound();
  const id = fixture.final.execution.id;
  const runtime = withObservation(transport({ overview: async () => fixture.overview, transcript: async () => ({ messages: fixture.messages }), memory: async () => fixture.memory, execution: async () => fixture.final }));
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  await settle();
  const rounds = app.store.getState().data.rounds;
  const conversation = app.store.getState().data.conversation;
  await app.commands.loadExecution(id);
  assert.equal(app.store.getState().data.rounds, rounds);
  assert.equal(app.store.getState().data.conversation, conversation);
  assert.equal(app.store.getState().data.details.get(id).memory.changes.length, 1);
  assert.equal(runtime.getSnapshot().observation.updates.size, 0);
  disconnect();
});

test('live overview separates the last recorded process from an unfinished invocation duration', async () => {
  const live = snapshot('running');
  live.execution.value.transcriptRange = { start: 0, end: 1, messages: [{ role: 'user', content: '你好，查看北京' }] };
  live.execution.value.processes = [{ sequence: 1, round: 1, occurredAt: '2026-09-25T00:00:00.025Z', offsetMs: 25, stage: 'execute', type: 'start', input: {} }];
  let observe;
  const runtime = withObservation(
    transport({
      observe: async (next, signal) => {
        observe = next;
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      },
      run: async (_request, receive, accepted) => {
        accepted();
        receive({ type: 'started', contextId: live.execution.contextId, inputIndex: 0 });
        observe(live);
      },
    }),
  );
  await runtime.initialize();
  await settle();
  const app = createApplication(runtime);
  const disconnect = app.connect();
  let overview;
  const unsubscribe = app.store.subscribe(({ data }) => {
    if (data.runningId && data.busy && data.rounds.length) overview = data;
  });
  await runtime.submit({ messages: [live.execution.value.input] });
  unsubscribe();
  disconnect();
  assert.equal(overview.rounds[0].observedOffsetMs, 25);
  assert.equal(overview.rounds[0].durationMs, undefined);
  assert.equal(overview.rounds[0].calls[0].durationMs, undefined);
  assert.equal(overview.rounds[0].inputIndex, 0);
});

test('binding supports a conversation-only runtime and never synthesizes responses from execution records', async () => {
  const messages = [...history];
  const runtime = new ClientRuntime({
    conversation: transport({
      transcript: async () => ({ messages: [...messages] }),
      run: async (request, receive, accepted) => {
        messages.push(...request.messages);
        accepted();
        deliverAnswer(receive, messages.length - 1, 'business-context', '独立回答');
        messages.push({ role: 'assistant', content: '独立回答' });
      },
      overview: async () => assert.fail('No observation reads'),
    }),
  });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  app.store.getState().setDraft('继续');
  await app.commands.submit();
  assert.equal(app.store.getState().data.conversation.at(-1).message.content, '独立回答');
  assert.equal(app.store.getState().data.rounds.length, 0);
  assert.equal(app.store.getState().notice, '');
  disconnect();
});
