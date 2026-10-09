import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '@capix-observer/client-runtime';
import { initializeObserver, observeExecution, observeOverview, ObservationFeed } from '@capix-observer/service';
import { Transcript, observeMemory } from '@capix-observer/runtime';
import { projectDetail } from '../../apps/observer/.test-dist/binding/details.js';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { client, deferred, snapshot, transport, deliverAnswer } from '../client/fixtures.mjs';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const withObservation = (io) => client({ conversation: io, observation: io });

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
  const feed = new ObservationFeed(environment);
  const frames = [];
  feed.connect((frame) => frames.push(frame));
  const final = await observeExecution(environment.runtime, environment.recording, request, { settings }, (value) => snapshots.push(value));
  await settle();
  feed.close();
  return { transcriptId: environment.transcript.id, frames, snapshots, final, overview: observeOverview(environment), messages: environment.transcript.snapshot(), memory: observeMemory(environment.memories, environment.book) };
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
      baseline: fixture.frames[0],
      overview: async () => (finished ? fixture.overview : { messages: history.map((message, index) => ({ index, message, count: 0 })), executions: [] }),
      transcript: async () => ({ id: fixture.transcriptId, revision: finished ? 3 : 1, start: 0, end: finished ? fixture.messages.length : history.length, starts: [0], messages: finished ? fixture.messages : history }),
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
  for (const value of fixture.frames.slice(1)) observe(value);
  const id = fixture.final.execution.id;
  const data = app.store.getState().data;
  assert.equal(runtime.getSnapshot().observation.overview.executions.length, 0, 'runtime does not build live overview');
  assert.equal(runtime.getSnapshot().observation.records.get(id).execution.status, fixture.final.execution.status);
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
  assert.ok(data.details.get(id).resources.length > 0);
  assert.equal(data.details.get(id).settings.model, 'fixture');
  assert.equal(data.details.get(id).transcriptRange.transcriptId, fixture.transcriptId);
  assert.equal('settings' in fixture.final.execution.value, false);
  assert.equal('messages' in data.details.get(id).transcriptRange, false);
  gate.resolve();
  await submitting;
  await settle();
  assert.equal(runtime.getSnapshot().observation.updates.size, 1);
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
    transcript: async () => ({ id: fixture.transcriptId, revision: finished ? 3 : 1, start: 0, end: finished ? fixture.messages.length : history.length, starts: [0], messages: finished ? fixture.messages : history }),
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
  const runtime = withObservation(transport({ overview: async () => fixture.overview, transcript: async () => ({ id: fixture.transcriptId, revision: 3, start: 0, end: fixture.messages.length, starts: [0], messages: fixture.messages }), memory: async () => fixture.memory, execution: async () => fixture.final }));
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
  live.resources.push({ id: 'range-bound', parentId: live.execution.id, access: 'transcript.fixedRange', supplyId: 'supply', sequence: 1, phase: 'bound', occurredAt: live.execution.value.startedAt, value: null });
  live.resources.push({ id: 'range', parentId: live.execution.id, access: 'transcript.fixedRange', supplyId: 'supply', sequence: 2, phase: 'available', occurredAt: live.execution.value.startedAt, value: { transcriptId: 'fixture-transcript', start: 0, end: 1 } });
  live.execution.value.processes = [{ sequence: 1, eventSequence: 2, round: 1, occurredAt: '2026-09-25T00:00:00.025Z', offsetMs: 25, stage: 'execute', type: 'start', input: {} }];
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
  await settle();
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
  const runtime = client({
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

test('detail keeps R acceptance separate from QA/E and exposes recorded relation entries', async () => {
  const fixture = await recordedRound();
  const detail = projectDetail(fixture.final, fixture.memory);
  const parent = fixture.final.runtimeCall;
  assert.ok(parent);
  assert.equal(detail.calls.get(detail.id).parentId, parent.id);
  const call = detail.calls.get(parent.id);
  assert.equal(call.recordType, 'runtime');
  assert.equal(call.status, 'passed');
  assert.equal(call.children.length, 1);
  assert.equal(call.children[0].id, detail.id);
  assert.deepEqual(
    call.relationEntries.map((entry) => entry.change.kind),
    ['attached', 'returned', 'receiving', 'accepted'],
  );
  assert.equal(call.relationEntries.at(-1).childId, detail.id);
  assert.equal(
    detail.children.some((entry) => entry.id === parent.id),
    false,
    'R is a parent detail, not another QA lane',
  );
  assert.ok(call.durationMs >= 0);
});
