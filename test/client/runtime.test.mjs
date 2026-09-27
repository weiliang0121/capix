import test from 'node:test';
import assert from 'node:assert/strict';
import { ClientRuntime } from '@capix-observer/client-runtime';
import { ObserverHttpTransport } from '@capix-observer/client-http';
import { deferred, snapshot, transport } from './fixtures.mjs';

const request = () => ({ messages: [{ role: 'user', content: '你好，查看北京' }], contextBudget: 32768 });

test('headless initialization shares one load, does not preload records, and supports unsubscribe', async () => {
  let loads = 0;
  let changes = 0;
  let detailReads = 0;
  const runtime = new ClientRuntime(
    transport({
      config: async () => {
        loads++;
        return { configured: true, contextBudget: 32768 };
      },
      execution: async (id) => {
        detailReads++;
        return snapshot('succeeded', id);
      },
    }),
  );
  const before = runtime.getSnapshot();
  const unsubscribe = runtime.subscribe(() => {
    changes++;
  });
  const first = runtime.initialize();
  assert.equal(runtime.initialize(), first);
  await first;
  assert.equal(loads, 1);
  assert.equal(detailReads, 0);
  assert.equal(changes, 1);
  assert.notEqual(runtime.getSnapshot(), before);
  assert.equal(runtime.getSnapshot(), runtime.getSnapshot());
  unsubscribe();
  await runtime.loadExecution('unloaded');
  assert.equal(detailReads, 1);
  assert.equal(changes, 1);
});

test('submission distinguishes pending input, HTTP acceptance, execution identity, and final reconciliation', async () => {
  const gate = deferred();
  let callbacks;
  let runs = 0;
  let accepted = 0;
  let finished = false;
  const input = request();
  const finalMessages = [...input.messages, { role: 'assistant', content: '回答' }];
  const runtime = new ClientRuntime(
    transport({
      transcript: async () => ({ messages: finished ? finalMessages : [] }),
      memory: async () => ({ items: finished ? [{ id: 'memory-1' }] : [] }),
      run: async (value, observe, accept) => {
        runs++;
        callbacks = { value, observe, accept };
        await gate.promise;
        finished = true;
      },
    }),
  );
  await runtime.initialize();
  const operation = runtime.submit(input, () => {
    accepted++;
  });
  input.messages[0].content = '调用方修改';
  assert.equal(runtime.getSnapshot().busy, true);
  assert.equal(runtime.getSnapshot().pending, '你好，查看北京');
  assert.equal(runtime.getSnapshot().runningId, '');
  assert.equal(runtime.getSnapshot().messages.length, 0);
  assert.equal(callbacks.value.messages[0].content, '你好，查看北京');
  await assert.rejects(runtime.submit(request()), /仍在处理/);
  assert.equal(runs, 1);
  callbacks.accept();
  assert.equal(accepted, 1);
  assert.equal(runtime.getSnapshot().pending, '');
  assert.equal(runtime.getSnapshot().messages.length, 1);
  assert.equal(runtime.getSnapshot().runningId, '');
  callbacks.observe(snapshot('running'));
  assert.equal(runtime.getSnapshot().runningId, 'execution-1');
  assert.equal(runtime.getSnapshot().updates.get('execution-1').execution.status, 'running');
  callbacks.observe(snapshot());
  gate.resolve();
  await operation;
  assert.equal(runtime.getSnapshot().busy, false);
  assert.deepEqual(runtime.getSnapshot().messages, finalMessages);
  assert.equal(runtime.getSnapshot().memory.items[0].id, 'memory-1');
  assert.equal(runtime.getExecution('execution-1').execution.status, 'succeeded');
});

test('HTTP rejection does not append messages, notify acceptance, refresh, or retry', async () => {
  let runs = 0;
  let reads = 0;
  const runtime = new ClientRuntime(
    transport({
      overview: async () => {
        reads++;
        return { executions: [], messages: [] };
      },
      run: async () => {
        runs++;
        throw new Error('HTTP 409');
      },
    }),
  );
  await runtime.initialize();
  await assert.rejects(
    runtime.submit(request(), () => assert.fail('Not accepted')),
    /409/,
  );
  assert.equal(runs, 1);
  assert.equal(reads, 1);
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runtime.getSnapshot().pending, '');
  assert.equal(runtime.getSnapshot().messages.length, 0);
});

test('recorded execution failure is preserved as a server result, not a transport rejection', async () => {
  let runs = 0;
  const failed = snapshot('failed');
  const runtime = new ClientRuntime(
    transport({
      run: async (_input, observe, accepted) => {
        runs++;
        accepted();
        observe(failed);
      },
    }),
  );
  await runtime.initialize();
  await runtime.submit(request());
  assert.equal(runtime.getExecution(failed.execution.id), failed);
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runs, 1);
});

test('stream failure preserves the last observation and refreshes accepted server state without retry', async () => {
  let runs = 0;
  let reads = 0;
  const live = snapshot('running');
  const runtime = new ClientRuntime(
    transport({
      transcript: async () => ({ messages: ++reads > 1 ? request().messages : [] }),
      run: async (_input, observe, accepted) => {
        runs++;
        accepted();
        observe(live);
        throw new Error('连接中断');
      },
    }),
  );
  await runtime.initialize();
  await assert.rejects(runtime.submit(request()), /连接中断/);
  assert.equal(runtime.getExecution(live.execution.id), live);
  assert.equal(runtime.getSnapshot().messages.length, 1);
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runs, 1);
  assert.equal(reads, 2);
});

test('refresh failure releases local submission state and keeps the terminal snapshot', async () => {
  let reads = 0;
  const runtime = new ClientRuntime(
    transport({
      transcript: async () => ({ messages: request().messages }),
      memory: async () => {
        if (++reads > 1) throw new Error('刷新失败');
        return { items: [] };
      },
      run: async (_input, observe, accepted) => {
        accepted();
        observe(snapshot());
      },
    }),
  );
  await runtime.initialize();
  await assert.rejects(runtime.submit(request()), /刷新失败/);
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runtime.getSnapshot().pending, '');
  assert.equal(runtime.getSnapshot().messages.length, 1);
  assert.equal(runtime.getExecution('execution-1').execution.status, 'succeeded');
});

test('detail cache is shared with streaming and a late detail response cannot replace the newer observation', async () => {
  const detail = deferred();
  const run = deferred();
  let observe;
  let accept;
  let reads = 0;
  const runtime = new ClientRuntime(
    transport({
      execution: async () => {
        reads++;
        return detail.promise;
      },
      run: async (_input, callback, accepted) => {
        observe = callback;
        accept = accepted;
        await run.promise;
      },
    }),
  );
  await runtime.initialize();
  const loading = runtime.loadExecution('execution-1');
  const submitting = runtime.submit(request());
  accept();
  observe(snapshot('running'));
  const terminal = snapshot();
  observe(terminal);
  detail.resolve(snapshot('running'));
  assert.equal(await loading, terminal);
  assert.equal(await runtime.loadExecution('execution-1'), terminal);
  assert.equal(reads, 1);
  run.resolve();
  await submitting;
});

test('HTTP transport preserves endpoint paths, request body, acceptance order and read cancellation', async () => {
  const calls = [];
  const order = [];
  const http = new ObserverHttpTransport('http://observer.test', async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/api/run') ? new Response(JSON.stringify({ type: 'snapshot', snapshot: snapshot() }) + '\n') : Response.json({ path: 'a b.ts', content: 'source' });
  });
  const runtime = new ClientRuntime(http);
  const controller = new AbortController();
  assert.equal((await runtime.source('a b.ts', controller.signal)).content, 'source');
  assert.equal(calls[0].url, 'http://observer.test/api/source?file=a%20b.ts');
  assert.equal(calls[0].init.signal, controller.signal);
  await http.run(
    request(),
    () => order.push('snapshot'),
    () => order.push('accepted'),
  );
  assert.deepEqual(order, ['accepted', 'snapshot']);
  assert.equal(calls[1].url, 'http://observer.test/api/run');
  assert.deepEqual(JSON.parse(calls[1].init.body), request());
});

test('memory refresh failure still commits the refreshed conversation', async () => {
  let finished = false;
  const answer = { role: 'assistant', content: '已完成的回答' };
  const runtime = new ClientRuntime(
    transport({
      transcript: async () => ({ messages: finished ? [...request().messages, answer] : [] }),
      memory: async () => {
        if (finished) throw new Error('记忆刷新失败');
        return { items: [] };
      },
      run: async (_input, _observe, accepted) => {
        accepted();
        finished = true;
      },
    }),
  );
  await runtime.initialize();
  await assert.rejects(runtime.submit(request()), /记忆刷新失败/);
  assert.deepEqual(runtime.getSnapshot().messages.at(-1), answer);
  assert.equal(runtime.getSnapshot().busy, false);
});

test('stream and refresh failures are both preserved without retry', async () => {
  const streamError = new Error('记录流中断');
  const refreshError = new Error('刷新失败');
  let runs = 0;
  const runtime = new ClientRuntime(
    transport({
      memory: async () => {
        if (runs) throw refreshError;
        return { items: [] };
      },
      run: async (_input, _observe, accepted) => {
        runs++;
        accepted();
        throw streamError;
      },
    }),
  );
  await runtime.initialize();
  await assert.rejects(runtime.submit(request()), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [streamError, refreshError]);
    assert.equal(error.cause, streamError);
    return true;
  });
  assert.equal(runtime.getSnapshot().busy, false);
  assert.equal(runs, 1);
});

test('failed conversation refresh retains observed association while memory can refresh', async () => {
  let finished = false;
  const observed = snapshot();
  const runtime = new ClientRuntime(
    transport({
      overview: async () => {
        if (finished) throw new Error('概览刷新失败');
        return { messages: [], executions: [] };
      },
      transcript: async () => ({ messages: finished ? [{ role: 'user', content: '不能脱离关联单独替换' }] : [] }),
      memory: async () => ({ items: finished ? [{ id: 'memory-1' }] : [] }),
      run: async (_input, observe, accepted) => {
        accepted();
        observe(observed);
        finished = true;
      },
    }),
  );
  await runtime.initialize();
  await assert.rejects(runtime.submit(request()), /概览刷新失败/);
  assert.equal(runtime.getSnapshot().updates.get(observed.execution.id).execution.id, observed.execution.id);
  assert.deepEqual(runtime.getSnapshot().messages, request().messages);
  assert.equal(runtime.getSnapshot().memory.items[0].id, 'memory-1');
  assert.equal(runtime.getSnapshot().busy, false);
});
