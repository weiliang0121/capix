import test from 'node:test';
import assert from 'node:assert/strict';
import { installFrames } from './frames.mjs';
import { ClientRuntime } from '@capix/client-runtime';
import { createAppStore } from '../../apps/observer/.test-dist/state/store.js';
import { connectAppStore } from '../../apps/observer/.test-dist/binding/application.js';
import { submitDraft } from '../../apps/observer/.test-dist/binding/submit.js';
import { client, deferred, snapshot, transport, submissionSnapshot, submissionDelivery } from '../client/fixtures.mjs';

const submitting = (pending) => ({ submission: { id: 'current', queueId: 'local-current', pending, feedback: { status: 'connecting' } } });
const pendingInput = (store) => store.getState().data.conversation.find((item) => item.kind === 'pending-input')?.content;

test('app stores are isolated and inspecting a node updates selection and dialogs together', () => {
  const runtime = client({ conversation: transport() });
  const first = createAppStore();
  const second = createAppStore();
  const observed = runtime.getSnapshot();
  first.getState().setMemoryOpen(true);
  const changes = [];
  const unsubscribe = first.subscribe((value) => changes.push(value));
  first.getState().inspect('execution-a', 'operation-a');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].selectedId, 'execution-a');
  assert.deepEqual(changes[0].inspection, { executionId: 'execution-a', callId: 'operation-a' });
  assert.equal(changes[0].memoryOpen, false);
  assert.equal(second.getState().selectedId, '');
  assert.equal(runtime.getSnapshot(), observed);
  first.getState().closeInspection();
  assert.equal(first.getState().selectedId, 'execution-a');
  assert.equal(first.getState().inspection, undefined);
  unsubscribe();
});

test('editing search resets its cursor without changing the selected round or runtime', () => {
  const runtime = client({ conversation: transport() });
  const store = createAppStore();
  store.getState().select('kept');
  store.getState().setMatchCursor(3);
  store.getState().setSearch('上海');
  assert.equal(store.getState().matchCursor, -1);
  assert.equal(store.getState().selectedId, 'kept');
  assert.equal(runtime.getSnapshot().messages.length, 0);
});

test('local queue acceptance clears submitted edits and prevents concurrent transport sends', async (t) => {
  const frames = installFrames(t);
  const gate = deferred();
  let accept;
  const sent = [];
  let calls = 0;
  const io = transport({
    submit: async (request, receive) => {
      calls++;
      sent.push(request.input);
      const delivery = io.delivery(request, receive);
      accept = () => delivery.input();
      if (calls === 1) await gate.promise;
      delivery.complete();
    },
  });
  const runtime = client({ conversation: io });
  const store = createAppStore();
  await runtime.initialize();
  store.getState().setDraft('继续讨论');
  store.getState().setHistory('[{"role":"assistant","content":"已有回答"}]');
  const operation = submitDraft(store, runtime);
  assert.equal(store.getState().draft, '');
  assert.equal(store.getState().history, '[]');
  store.getState().setDraft('继续排队');
  await submitDraft(store, runtime);
  await frames.flush();
  assert.equal(calls, 1);
  assert.equal(store.getState().draft, '');
  assert.equal(runtime.getSnapshot().queue.waiting.length, 1);
  assert.deepEqual(sent[0].messages, [
    { role: 'assistant', content: '已有回答' },
    { role: 'user', content: '继续讨论' },
  ]);
  assert.equal(runtime.getSnapshot().pending, '继续讨论');
  accept();
  await frames.flush();
  assert.equal(store.getState().draft, '');
  assert.equal(store.getState().history, '[]');
  assert.equal(runtime.getSnapshot().messages.length, 2);
  for (const field of ['messages', 'overview', 'memory', 'busy', 'runningId']) assert.equal(field in store.getState(), false);
  gate.resolve();
  await operation;
  await frames.flush();
  assert.equal(calls, 2);
  assert.deepEqual(sent[1].messages, [{ role: 'user', content: '继续排队' }]);
});

test('remote rejection preserves the submitted preview after local acceptance cleared the draft', async (t) => {
  const frames = installFrames(t);
  const runtime = client({
    conversation: transport({
      submit: async (request, receive) => receive(submissionSnapshot(request.submissionId, { revision: 1, result: { status: 'rejected', error: { code: 'RUNTIME_BUSY', message: '服务忙碌' } } })),
    }),
  });
  const store = createAppStore();
  await runtime.initialize();
  store.getState().setDraft('保留这条输入');
  await submitDraft(store, runtime);
  await frames.flush();
  assert.equal(store.getState().draft, '');
  assert.equal(store.getState().notice, '');
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'rejected');
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runtime.getSnapshot().submission.pending, '保留这条输入');
  assert.equal(runtime.getSnapshot().queue.blocked, undefined);
  assert.deepEqual(runtime.getSnapshot().messages, []);
});

test('invalid form input never reaches the queue and late remote acceptance preserves newer edits', async (t) => {
  const frames = installFrames(t);
  let accept;
  let calls = 0;
  const gate = deferred();
  const runtime = client({
    conversation: transport({
      submit: async (request, receive) => {
        calls++;
        const delivery = submissionDelivery(request, receive);
        accept = () => delivery.input();
        await gate.promise;
        delivery.complete();
      },
    }),
  });
  const store = createAppStore();
  await runtime.initialize();
  store.getState().setDraft('原草稿');
  store.getState().setBudget('255');
  await submitDraft(store, runtime);
  assert.match(store.getState().notice, /容量预算/);
  store.getState().setBudget('32768');
  store.getState().setHistory('[{"role":"system","content":"不能追加"}]');
  await submitDraft(store, runtime);
  assert.match(store.getState().notice, /user \/ assistant/);
  assert.equal(calls, 0);
  store.getState().setHistory('[]');
  const operation = submitDraft(store, runtime);
  await frames.flush();
  store.getState().setDraft('后续新草稿');
  store.getState().setHistory('[{"role":"user","content":"新编辑"}]');
  accept();
  await frames.flush();
  assert.equal(store.getState().draft, '后续新草稿');
  assert.match(store.getState().history, /新编辑/);
  gate.resolve();
  await operation;
});

test('app connection follows streamed execution, retains edited budget on cache updates and cleans up', async (t) => {
  const frames = installFrames(t);
  const gate = deferred();
  let observe;
  const io = transport({
    config: async () => ({ configured: true, contextBudget: 4096 }),
    overview: async () => ({ messages: [], executions: [{ id: 'previous', startedAt: '2026-09-25T00:00:00.000Z', status: 'succeeded', inputIndex: 0, selections: [], calls: [], observedOffsetMs: 10, durationMs: 10, availableMemoryIds: [], memoryChanges: [] }] }),
    observe: async (next, signal) => {
      observe = next;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    submit: async (request, next) => {
      const delivery = io.delivery(request, next);
      delivery.input();
      delivery.execution('context-new');
      await gate.promise;
      delivery.complete();
    },
  });
  const runtime = client({ conversation: io, observation: io });
  const store = createAppStore();
  const disconnect = connectAppStore(store, runtime);
  await runtime.initialize();
  await frames.flush();
  assert.equal(store.getState().budget, '4096');
  assert.equal(store.getState().selectedId, 'previous');
  store.getState().setBudget('8192');
  await runtime.loadExecution('detail');
  assert.equal(store.getState().budget, '8192');
  const operation = runtime.submit({ messages: [{ role: 'user', content: '开始' }] });
  observe(snapshot('running', 'new'));
  await frames.flush();
  assert.equal(store.getState().selectedId, 'new');
  disconnect();
  store.getState().select('manual');
  observe(snapshot('succeeded', 'new'));
  assert.equal(store.getState().selectedId, 'manual');
  assert.equal(store.getState().budget, '8192');
  gate.resolve();
  await operation;
});

test('unmounted app ignores late initialization errors and reconnect establishes a new subscription', async (t) => {
  const frames = installFrames(t);
  const gate = deferred();
  let loads = 0;
  const runtime = client({
    conversation: transport({
      config: async () => {
        loads++;
        return gate.promise;
      },
    }),
  });
  const store = createAppStore();
  const disconnect = connectAppStore(store, runtime);
  disconnect();
  gate.reject(new Error('配置读取失败'));
  await assert.rejects(runtime.initialize(), /配置读取失败/);
  assert.equal(store.getState().notice, '');
  const reconnect = connectAppStore(store, runtime);
  await runtime.initialize().catch(() => {});
  await frames.flush();
  assert.equal(store.getState().notice, '');
  assert.match(store.getState().data.conversationSync.message, /对话连接未能建立/);
  assert.equal(store.getState().data.conversationSync.reconnect, true);
  assert.equal(loads, 3, 'a failed explicit attempt is not reused when the app reconnects');
  reconnect();
});

test('a previous initialization promise cannot replace the status of a reconnected healthy application', async (t) => {
  const frames = installFrames(t);
  const previous = deferred();
  const initial = client({ conversation: transport() }).getSnapshot();
  let observed = { ...initial, initialization: { status: 'running', attempt: 1 } };
  let notify;
  let attempts = 0;
  const runtime = {
    getSnapshot: () => observed,
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
    initialize: () => {
      attempts++;
      return attempts === 1 ? previous.promise : Promise.resolve();
    },
    startObservation: () => () => {},
    stopTranscript: () => {},
  };
  const store = createAppStore();
  const disconnect = connectAppStore(store, runtime);
  disconnect();
  const reconnect = connectAppStore(store, runtime);
  observed = { ...initial, initialization: { status: 'succeeded', attempt: 2 } };
  notify();
  previous.reject(new DOMException('旧连接已停止', 'AbortError'));
  await frames.flush();
  assert.equal(store.getState().notice, '');
  assert.equal(store.getState().data.conversationSync, undefined);
  reconnect();
});

test('binding projects the initial state immediately and commits only the latest publication in one frame', async (t) => {
  const frames = installFrames(t);
  const initial = client({ conversation: transport() }).getSnapshot();
  let observed = { ...initial, ...submitting('初始输入') };
  let notify;
  const runtime = {
    getSnapshot: () => observed,
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
    initialize: async () => {},
    startObservation: () => () => {},
    stopTranscript: () => {},
  };
  const store = createAppStore();
  let commits = 0;
  store.subscribe(() => commits++);
  const disconnect = connectAppStore(store, runtime);
  assert.equal(pendingInput(store), '初始输入');
  assert.equal(commits, 1);
  observed = { ...initial, ...submitting('第一次更新') };
  notify();
  observed = { ...initial, ...submitting('第二次更新') };
  notify();
  assert.equal(commits, 1);
  assert.equal(frames.pending, 1);
  // Snapshot is read when the frame runs, not captured by the earlier notification.
  observed = { ...initial, ...submitting('最终更新') };
  await frames.flush();
  assert.equal(pendingInput(store), '最终更新');
  assert.equal(commits, 2);
  notify();
  assert.equal(frames.pending, 1);
  disconnect();
  assert.equal(frames.pending, 0);
  notify();
  await frames.flush();
  assert.equal(commits, 2, 'queued and late notifications cannot write after cleanup');
});

test('projection failure stays in the binding and the next valid publication can still update', async (t) => {
  const frames = installFrames(t);
  const initial = client({ conversation: transport() }).getSnapshot();
  let observed = initial;
  let notify;
  const runtime = {
    getSnapshot: () => observed,
    subscribe: (listener) => {
      notify = listener;
      return () => {};
    },
    initialize: async () => {},
    startObservation: () => () => {},
    stopTranscript: () => {},
  };
  const store = createAppStore();
  const disconnect = connectAppStore(store, runtime);
  const previous = store.getState().data;
  observed = {
    ...initial,
    get observation() {
      throw new Error('投影失败');
    },
  };
  assert.doesNotThrow(() => notify(), 'a binding error cannot fail the delivery callback');
  await frames.flush();
  assert.equal(store.getState().data, previous);
  assert.match(store.getState().notice, /界面数据更新失败.*投影失败/);
  observed = { ...initial, ...submitting('继续接纳') };
  notify();
  await frames.flush();
  assert.equal(pendingInput(store), '继续接纳');
  assert.equal(store.getState().notice, '');
  disconnect();
});
