import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '@capix/client-runtime';
import { createAppStore } from '../../apps/observer/.test-dist/state/store.js';
import { connectAppStore } from '../../apps/observer/.test-dist/binding/application.js';
import { submitDraft } from '../../apps/observer/.test-dist/binding/submit.js';
import { client, deferred, snapshot, transport } from '../client/fixtures.mjs';

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

test('submission keeps edits until acceptance, prevents concurrent sends and leaves server observations in runtime until binding commits application data', async () => {
  const gate = deferred();
  let accept;
  let sent;
  let calls = 0;
  const runtime = client({
    conversation: transport({
      run: async (request, observe, accepted) => {
        calls++;
        sent = request;
        accept = accepted;
        await gate.promise;
      },
    }),
  });
  const store = createAppStore();
  await runtime.initialize();
  store.getState().setDraft('继续讨论');
  store.getState().setHistory('[{"role":"assistant","content":"已有回答"}]');
  const operation = submitDraft(store, runtime);
  await submitDraft(store, runtime);
  assert.equal(calls, 1);
  assert.equal(store.getState().draft, '继续讨论');
  assert.deepEqual(sent.messages, [
    { role: 'assistant', content: '已有回答' },
    { role: 'user', content: '继续讨论' },
  ]);
  assert.equal(runtime.getSnapshot().pending, '继续讨论');
  accept();
  assert.equal(store.getState().draft, '');
  assert.equal(store.getState().history, '[]');
  assert.equal(runtime.getSnapshot().messages.length, 2);
  for (const field of ['messages', 'overview', 'memory', 'busy', 'runningId']) assert.equal(field in store.getState(), false);
  gate.resolve();
  await operation;
});

test('rejected submission preserves edits and reports an application notice without appending messages', async () => {
  const runtime = client({
    conversation: transport({
      run: async () => {
        throw new Error('HTTP 409');
      },
    }),
  });
  const store = createAppStore();
  await runtime.initialize();
  store.getState().setDraft('保留这条输入');
  await submitDraft(store, runtime);
  assert.equal(store.getState().draft, '保留这条输入');
  assert.equal(store.getState().notice, 'HTTP 409');
  assert.deepEqual(runtime.getSnapshot().messages, []);
});

test('invalid form input never reaches the runtime submission and late acceptance preserves newer edits', async () => {
  let accept;
  let calls = 0;
  const gate = deferred();
  const runtime = client({
    conversation: transport({
      run: async (request, observe, accepted) => {
        calls++;
        accept = accepted;
        await gate.promise;
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
  store.getState().setDraft('后续新草稿');
  store.getState().setHistory('[{"role":"user","content":"新编辑"}]');
  accept();
  assert.equal(store.getState().draft, '后续新草稿');
  assert.match(store.getState().history, /新编辑/);
  gate.resolve();
  await operation;
});

test('app connection follows streamed execution, retains edited budget on cache updates and cleans up', async () => {
  const gate = deferred();
  let observe;
  const io = transport({
    config: async () => ({ configured: true, contextBudget: 4096 }),
    overview: async () => ({ messages: [], executions: [{ id: 'previous', startedAt: '2026-09-25T00:00:00.000Z', status: 'succeeded', inputIndex: 0, selections: [], calls: [], observedOffsetMs: 10, durationMs: 10, availableMemoryIds: [], memoryChanges: [] }] }),
    observe: async (next, signal) => {
      observe = next;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    run: async (request, next) => {
      next({ type: 'started', contextId: 'context-new', inputIndex: 0 });
      await gate.promise;
    },
  });
  const runtime = client({ conversation: io, observation: io });
  const store = createAppStore();
  const disconnect = connectAppStore(store, runtime);
  await runtime.initialize();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getState().budget, '4096');
  assert.equal(store.getState().selectedId, 'previous');
  store.getState().setBudget('8192');
  await runtime.loadExecution('detail');
  assert.equal(store.getState().budget, '8192');
  const operation = runtime.submit({ messages: [{ role: 'user', content: '开始' }] });
  observe(snapshot('running', 'new'));
  assert.equal(store.getState().selectedId, 'new');
  disconnect();
  store.getState().select('manual');
  observe(snapshot('succeeded', 'new'));
  assert.equal(store.getState().selectedId, 'manual');
  assert.equal(store.getState().budget, '8192');
  gate.resolve();
  await operation;
});

test('unmounted app ignores late initialization errors and reconnect establishes a new subscription', async () => {
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
  assert.equal(store.getState().notice, '配置读取失败');
  assert.equal(loads, 3, 'a failed explicit attempt is not reused when the app reconnects');
  reconnect();
});
