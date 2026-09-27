import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '@capix-observer/client-runtime';
import { initializeObserver, acceptExecutionInput, observeExecution, observeOverview } from '@capix-observer/service';
import { Transcript, observeMemory } from '@capix-observer/runtime';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { deferred, snapshot, transport } from '../client/fixtures.mjs';

const request = { messages: [{ role: 'user', content: '上海，周末去' }] };
const history = [
  { role: 'user', content: '计划去旅行' },
  { role: 'assistant', content: '去哪里？' },
];
const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1024, timeoutMs: 1000 };
const raw = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });

async function recordedRound() {
  const snapshots = [];
  const environment = initializeObserver({ invoke: async (_request, purpose) => raw(purpose === 'selection' ? { historyIndexes: [0, 1] } : purpose === 'answer' ? { kind: 'answer', content: '上海周末行程。' } : { memories: [{ action: 'create', memoryId: null, change: '确认目的地', sourceIndexes: [2], result: { topic: '旅行', content: '周末去上海', sourceIndexes: [2] } }] }) }, new Transcript(history));
  const input = acceptExecutionInput(environment.transcript, request);
  const final = await observeExecution(environment.execution, environment.recorder, input, { settings, transcript: environment.transcript }, (value) => snapshots.push(value));
  return { snapshots, final, overview: observeOverview(environment), messages: environment.transcript.snapshot(), memory: observeMemory(environment.execution.memories, environment.transcript, environment.book) };
}

test('binding interprets live records, reconciles once, and keeps raw runtime separate from application models', async () => {
  const fixture = await recordedRound();
  const gate = deferred();
  let observe;
  let accept;
  let finished = false;
  let detailReads = 0;
  const runtime = new ClientRuntime(
    transport({
      overview: async () => (finished ? fixture.overview : { messages: history.map((message, index) => ({ index, message, count: 0 })), executions: [] }),
      transcript: async () => ({ messages: finished ? fixture.messages : history }),
      memory: async () => (finished ? fixture.memory : { items: [] }),
      execution: async () => {
        detailReads++;
        return fixture.final;
      },
      run: async (_request, next, accepted) => {
        observe = next;
        accept = accepted;
        await gate.promise;
        finished = true;
      },
    }),
  );
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  assert.equal(detailReads, 0);
  app.store.getState().setSearch('上海');
  app.store.getState().setDraft(request.messages[0].content);
  const submitting = app.commands.submit();
  assert.equal(app.store.getState().data.pending, request.messages[0].content);
  accept();
  for (const value of fixture.snapshots) observe(value);
  const id = fixture.final.execution.id;
  const data = app.store.getState().data;
  assert.equal(runtime.getSnapshot().overview.executions.length, 0, 'runtime does not build live overview');
  assert.equal(runtime.getSnapshot().records.get(id), fixture.final);
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
  assert.equal(runtime.getSnapshot().updates.size, 0);
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

test('binding remount reconstructs unreconciled answers, ignores disconnected notifications and preserves detail cache', async () => {
  const fixture = await recordedRound();
  let finished = false;
  const runtime = new ClientRuntime(
    transport({
      overview: async () => {
        if (finished) throw new Error('概览刷新失败');
        return { messages: history.map((message, index) => ({ index, message, count: 0 })), executions: [] };
      },
      transcript: async () => ({ messages: history }),
      run: async (_request, observe, accept) => {
        accept();
        observe(fixture.final);
        finished = true;
      },
    }),
  );
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  app.store.getState().setBudget('8192');
  disconnect();
  const before = app.store.getState().data;
  await assert.rejects(runtime.submit(request), /概览刷新失败/);
  assert.equal(app.store.getState().data, before);
  const reconnect = app.connect();
  assert.equal(app.store.getState().budget, '8192');
  assert.equal(app.store.getState().data.conversation.at(-1).message.content, '上海周末行程。');
  assert.equal(app.store.getState().data.details.get(fixture.final.execution.id).answer, '上海周末行程。');
  assert.equal(app.store.getState().data.busy, false);
  assert.equal(runtime.getSnapshot().updates.size, 1);
  reconnect();
});

test('loading old detail records does not replace a fresh server overview or repeat selection counts', async () => {
  const fixture = await recordedRound();
  const id = fixture.final.execution.id;
  const runtime = new ClientRuntime(transport({ overview: async () => fixture.overview, transcript: async () => ({ messages: fixture.messages }), memory: async () => fixture.memory, execution: async () => fixture.final }));
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  const rounds = app.store.getState().data.rounds;
  const conversation = app.store.getState().data.conversation;
  await app.commands.loadExecution(id);
  assert.equal(app.store.getState().data.rounds, rounds);
  assert.equal(app.store.getState().data.conversation, conversation);
  assert.equal(app.store.getState().data.details.get(id).memory.changes.length, 1);
  assert.equal(runtime.getSnapshot().updates.size, 0);
  disconnect();
});

test('live overview separates the last recorded process from an unfinished invocation duration', async () => {
  const live = snapshot('running');
  live.execution.value.transcriptRange = { start: 0, end: 1, messages: [{ role: 'user', content: '你好，查看北京' }] };
  live.execution.value.processes = [{ sequence: 1, round: 1, occurredAt: '2026-09-25T00:00:00.025Z', offsetMs: 25, stage: 'execute', type: 'start', input: {} }];
  const runtime = new ClientRuntime(
    transport({
      run: async (_request, accept, accepted) => {
        accepted();
        accept(live);
      },
    }),
  );
  await runtime.initialize();
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
