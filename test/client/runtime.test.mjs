import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '@capix-observer/client-runtime';
import { client, deferred, snapshot, transport, deliverAnswer } from './fixtures.mjs';

const request = () => ({ messages: [{ role: 'user', content: '你好，查看北京' }], contextBudget: 32768 });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function conversation(overrides = {}) {
  const messages = [];
  return transport({
    transcript: async () => ({ messages: [...messages] }),
    run: async (request, receive, accepted) => {
      messages.push(...request.messages);
      accepted();
      deliverAnswer(receive, messages.length - 1);
      messages.push({ role: 'assistant', content: '这是中文回答' });
    },
    ...overrides,
  });
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

test('answer is delivered before postprocessing ends and an observation outage cannot reject submission', async () => {
  const gate = deferred();
  const messages = [];
  const io = transport({
    transcript: async () => ({ messages: [...messages] }),
    run: async (request, receive, accepted) => {
      messages.push(...request.messages);
      accepted();
      receive({ type: 'started', contextId: 'context', inputIndex: 0 });
      const output = { kind: 'answer', content: '已经回答' };
      messages.push({ role: 'assistant', content: output.content });
      receive({ type: 'answer', contextId: 'context', index: 1, output });
      await gate.promise;
      receive({ type: 'completed', contextId: 'context' });
    },
    overview: async () => {
      throw new Error('概览不可用');
    },
    memory: async () => {
      throw new Error('记忆观测不可用');
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
  gate.resolve();
  await running;
  stop();
  assert.equal(runtime.getSnapshot().busy, false);
});

test('postprocessing failure retains the independently synchronized answer without refreshing a healthy entity', async () => {
  let reads = 0;
  const postprocess = new Error('后处理失败');
  const refresh = new Error('消息刷新失败');
  const runtime = client({
    conversation: transport({
      transcript: async () => {
        if (reads++) throw refresh;
        return { messages: [] };
      },
      run: async (_request, receive, accepted) => {
        accepted();
        deliverAnswer(receive);
        throw postprocess;
      },
    }),
  });
  await runtime.initialize();
  await assert.rejects(runtime.submit(request()), (error) => {
    assert.equal(error, postprocess);
    return true;
  });
  assert.equal(runtime.getSnapshot().messages.at(-1).content, '这是中文回答');
  assert.equal(runtime.getSnapshot().busy, false);
});

test('HTTP rejection does not append, refresh, notify acceptance or retry', async () => {
  let runs = 0;
  let reads = 0;
  const runtime = client({
    conversation: transport({
      transcript: async () => {
        reads++;
        return { messages: [] };
      },
      run: async () => {
        runs++;
        throw new Error('HTTP 409');
      },
    }),
  });
  await runtime.initialize();
  await assert.rejects(
    runtime.submit(request(), () => assert.fail('Not accepted')),
    /409/,
  );
  assert.equal(runs, 1);
  assert.equal(reads, 1);
  assert.equal(runtime.getSnapshot().messages.length, 0);
  assert.equal(runtime.getSnapshot().busy, false);
});

test('local busy guard rejects concurrent submissions and stopping observation does not cancel work', async () => {
  const gate = deferred();
  const io = conversation({
    run: async (_request, receive, accepted) => {
      accepted();
      await gate.promise;
      deliverAnswer(receive);
    },
  });
  const runtime = client({ conversation: io, observation: io });
  await runtime.initialize();
  const stop = runtime.startObservation();
  const running = runtime.submit(request());
  await assert.rejects(runtime.submit(request()), /仍在处理/);
  stop();
  assert.equal(runtime.getSnapshot().busy, true);
  gate.resolve();
  await running;
  assert.equal(runtime.getSnapshot().observation.enabled, false);
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
