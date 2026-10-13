import test from 'node:test';
import assert from 'node:assert/strict';
import { client, deferred, snapshot, transport } from './fixtures.mjs';

const request = () => ({ messages: [{ role: 'user', content: '你好，查看北京' }], contextBudget: 32768 });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function conversation(overrides = {}) {
  const io = transport({
    submit: async (request, receive) => {
      const delivery = io.delivery(request, receive);
      delivery.input();
      delivery.execution();
      delivery.answer();
      delivery.complete();
    },
    ...overrides,
  });
  return io;
}

test('headless conversation initializes once and completes multiple rounds without observation methods', async () => {
  let loads = 0;
  const io = conversation({
    config: async () => {
      loads++;
      return { configured: true };
    },
  });
  for (const key of ['overview', 'memory', 'execution', 'source', 'observe']) delete io[key];
  const runtime = client({ conversation: io });
  let notifications = 0;
  const unsubscribe = runtime.subscribe(() => notifications++);
  const first = runtime.initialize();
  assert.equal(runtime.initialize(), first);
  await first;
  assert.equal(loads, 1);
  await runtime.submit(request());
  await runtime.submit(request());
  assert.equal(runtime.getSnapshot().messages.length, 4);
  assert.equal(runtime.getSnapshot().messages.at(-1).content, '这是中文回答');
  assert.equal(runtime.getSnapshot().observation.records.size, 0);
  assert.equal(runtime.getSnapshot().busy, false);
  const before = notifications;
  unsubscribe();
  await runtime.submit(request());
  assert.equal(notifications, before);
});

test('observation is opt-in even when its transport is supplied', async () => {
  const io = conversation();
  let reads = 0;
  for (const key of ['overview', 'memory', 'observe'])
    io[key] = async () => {
      reads++;
      throw new Error('must not call');
    };
  const runtime = client({ conversation: io, observation: io });
  await runtime.initialize();
  await runtime.submit(request());
  assert.equal(reads, 0);
});

test('answer is visible before postprocessing and observation outages never alter submission facts', async () => {
  const gate = deferred();
  const io = conversation({
    submit: async (request, receive) => {
      const delivery = io.delivery(request, receive);
      delivery.input();
      delivery.execution();
      delivery.answer('已经回答');
      await gate.promise;
      delivery.fail('POSTPROCESS', '后处理失败');
    },
    observe: async () => {
      throw new Error('观测连接中断');
    },
  });
  const runtime = client({ conversation: io, observation: io });
  const stop = runtime.startObservation();
  await runtime.initialize();
  const running = runtime.submit(request());
  await settle();
  assert.equal(runtime.getSnapshot().busy, true);
  assert.equal(runtime.getSnapshot().answered, true);
  assert.equal(runtime.getSnapshot().messages.at(-1).content, '已经回答');
  assert.ok(runtime.getSnapshot().observation.error);
  assert.equal(runtime.getSnapshot().error, undefined);
  stop();
  gate.resolve();
  await running;
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'failed');
  assert.equal(runtime.getSnapshot().submission.remote.result.error.code, 'POSTPROCESS');
  assert.equal(runtime.getSnapshot().messages.at(-1).content, '已经回答');
});

test('stream observations and detail caching remain separate from business message delivery', async () => {
  const detail = deferred();
  let receive;
  let reads = 0;
  const io = conversation({
    execution: async () => {
      reads++;
      return detail.promise;
    },
    observe: async (next, signal) => {
      receive = next;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  const runtime = client({ conversation: io, observation: io });
  await runtime.initialize();
  const stop = runtime.startObservation();
  await settle();
  const loading = runtime.loadExecution('execution-1');
  receive(snapshot('running'));
  const terminal = snapshot();
  receive(terminal);
  assert.equal(runtime.getSnapshot().messages.length, 0, 'records never create conversation messages');
  detail.resolve(snapshot('running'));
  assert.deepEqual(await loading, terminal);
  assert.deepEqual(await runtime.loadExecution('execution-1'), terminal);
  assert.equal(reads, 1);
  await runtime.submit(request());
  assert.equal(runtime.getSnapshot().messages.length, 2);
  stop();
});

test('late observation loads and notifications from a disconnected session cannot overwrite state', async () => {
  const old = deferred();
  let oldReceive;
  let reads = 0;
  const io = conversation({
    overview: async () => (++reads === 1 ? old.promise : { messages: [], executions: [] }),
    observe: async (next, signal) => {
      oldReceive ??= next;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
  });
  const runtime = client({ conversation: io, observation: io });
  await runtime.initialize();
  const stop = runtime.startObservation();
  stop();
  const stopNew = runtime.startObservation();
  await settle();
  oldReceive(snapshot());
  old.resolve({ executions: [{ id: 'stale' }], messages: [] });
  await settle();
  assert.equal(runtime.getSnapshot().observation.records.size, 0);
  assert.equal(runtime.getSnapshot().observation.overview.executions.length, 0);
  stopNew();
});

test('a completed E does not make its still-running parent R detail permanently cached', async () => {
  const execution = snapshot();
  const pending = snapshot('running');
  const running = { ...execution, runtimeCall: pending.runtimeCall, runtimeEvents: pending.runtimeEvents };
  const finished = execution;
  let reads = 0;
  const io = transport({ execution: async () => (++reads === 1 ? running : finished) });
  const runtime = client({ conversation: io, observation: io });
  await runtime.initialize();
  assert.equal((await runtime.loadExecution(execution.execution.id)).runtimeCall.status, 'running');
  assert.equal((await runtime.loadExecution(execution.execution.id)).runtimeCall.status, 'succeeded');
  assert.equal((await runtime.loadExecution(execution.execution.id)).runtimeCall.status, 'succeeded');
  assert.equal(reads, 2);
});
