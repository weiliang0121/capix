import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { ObserverHttpTransport } from '@capix-observer/client-http';
import { readOutput, validateSnapshot } from '@capix-observer/protocol';
import { createObserverServer, initializeObserver } from '@capix-observer/service';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 10000 };
const raw = (value) => ({ id: 'test', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const provider = {
  async invoke(_request, purpose) {
    return raw(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: '测试回答' });
  },
};
async function setup(t, model = provider) {
  const observer = initializeObserver(model);
  const server = createObserverServer({ observer, settings, configured: false });
  assert.equal(server.listening, false, 'service construction must not start listening');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path) => fetch(base + path).then((response) => response.json());
  const run = (content = '测试输入', options = {}) => fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...options.headers }, body: JSON.stringify(options.body ?? { messages: [{ role: 'user', content }] }) });
  return { observer, server, base, get, run };
}
const updates = async (response) =>
  (await response.text())
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test('HTTP overview exposes timing and associations without invocation bodies, while detail retains full records', async (t) => {
  const { get, run } = await setup(t);
  const response = await run();
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const stream = await updates(response);
  assert.ok(stream.length > 1);
  assert.ok(stream.every((item) => item.type === 'snapshot' && !('trace' in item)));
  const snapshot = stream.at(-1).snapshot;
  validateSnapshot(snapshot);
  assert.equal(snapshot.execution.status, 'succeeded');
  assert.equal(readOutput(snapshot.execution.value).content, '测试回答');
  const overview = await get('/api/executions');
  assert.equal(overview.executions.length, 1);
  assert.deepEqual(
    overview.messages.map(({ message }) => message.role),
    ['user', 'assistant'],
  );
  const execution = overview.executions[0];
  assert.equal(execution.calls.length, 1 + snapshot.operations.length + snapshot.attempts.length);
  assert.deepEqual(execution.transcriptRange, { start: 0, end: 1 });
  assert.deepEqual(execution.availableMemoryIds, []);
  assert.deepEqual(execution.response, { index: 1, content: '测试回答' });
  for (const call of execution.calls) {
    assert.equal(call.status, 'succeeded');
    assert.ok(call.durationMs >= 0);
    for (const key of ['value', 'input', 'output', 'processes', 'error']) assert.equal(Object.hasOwn(call, key), false);
  }
  const end = snapshot.events.at(-1).offsetMs;
  assert.equal(execution.observedOffsetMs, end);
  assert.equal(execution.durationMs, end - snapshot.events[0].offsetMs);
  const detail = await get('/api/execution?id=' + execution.id);
  assert.deepEqual(detail, snapshot);
  const path = snapshot.operations[0].source.split(' · ')[0];
  const source = await get('/api/source?file=' + encodeURIComponent(path));
  assert.equal(source.path, path);
  assert.match(source.content, /class SelectHistory/);
});

test('busy execution rejects another submission without adding messages or inventing a finished duration', async (t) => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const { get, run, observer } = await setup(t, {
    async invoke(request, purpose) {
      if (purpose === 'selection') await pending;
      return provider.invoke(request, purpose);
    },
  });
  try {
    const first = await run('first');
    const overview = await get('/api/executions');
    assert.equal(overview.executions[0].status, 'running');
    assert.equal(Object.hasOwn(overview.executions[0], 'durationMs'), false);
    assert.ok(overview.executions[0].observedOffsetMs >= 0);
    for (const call of overview.executions[0].calls.filter((call) => call.status === 'running')) assert.equal(Object.hasOwn(call, 'durationMs'), false);
    const busy = await run('must not append');
    assert.equal(busy.status, 409);
    assert.equal(observer.transcript.length, 1);
    release();
    assert.equal((await updates(first)).at(-1).snapshot.execution.status, 'succeeded');
  } finally {
    release();
  }
});

test('failed memory postprocessing still exposes the completed answer and the actual failed invocation', async (t) => {
  const { run, get } = await setup(t, {
    async invoke(request, purpose) {
      if (purpose === 'memory') throw new Error('fixture memory failure');
      return provider.invoke(request, purpose);
    },
  });
  const stream = await updates(await run());
  assert.equal(stream.at(-1).type, 'snapshot');
  assert.equal(stream.at(-1).snapshot.execution.status, 'failed');
  const { executions } = await get('/api/executions');
  assert.equal(executions[0].status, 'failed');
  assert.equal(executions[0].memoryStatus, 'failed');
  assert.deepEqual(executions[0].response, { content: '测试回答', index: 1 });
  assert.equal(executions[0].calls.filter((call) => call.status === 'failed').length, 3);
});

test('failure before a complete execution record produces a terminal transport error, never silent success', async (t) => {
  const { run, observer } = await setup(t);
  observer.execution.call = async () => {
    throw new Error('private diagnostic must not be an HTTP message');
  };
  const stream = await updates(await run());
  assert.deepEqual(stream, [{ type: 'error', error: '服务内部错误。', code: 'INTERNAL_ERROR' }]);
});

test('transport validates origin, input and source boundary before accepting work', async (t) => {
  const { run, base, observer, get } = await setup(t);
  assert.equal((await run('invalid origin', { headers: { Origin: 'https://outside.example' } })).status, 403);
  const invalid = await run('', { body: { messages: [{ role: 'assistant', content: 'invalid final role' }] } });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, 'INVALID_INPUT');
  assert.equal(observer.transcript.length, 0);
  assert.equal([...observer.book.values()].length, 0);
  for (const path of ['.env', '../../.env', 'services/observer/src/../../../../.env']) assert.equal((await fetch(base + '/api/source?file=' + encodeURIComponent(path))).status, 404);
  const blocked = await new Promise((resolve, reject) => {
    const req = request(base + '/api/config', { headers: { Host: 'outside.example' } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(blocked, 403);
  assert.deepEqual(await get('/api/config'), { ...settings, configured: false });
});

test('Observer HTTP subclass consumes the current service without changing its protocol', async (t) => {
  const { base } = await setup(t);
  const client = new ObserverHttpTransport(base);
  assert.deepEqual(await client.config(), { ...settings, configured: false });
  assert.deepEqual(await client.overview(), { messages: [], executions: [] });
  let accepted = false;
  const received = [];
  await client.run(
    { messages: [{ role: 'user', content: '测试输入' }] },
    (snapshot) => {
      assert.equal(accepted, true);
      received.push(snapshot);
    },
    () => {
      accepted = true;
    },
  );
  const last = received.at(-1);
  assert.equal(last.execution.status, 'succeeded');
  assert.ok(received.length > 1);
  assert.deepEqual(await client.execution(last.execution.id), last);
  assert.equal((await client.overview()).executions[0].response.content, '测试回答');
  assert.deepEqual(
    (await client.transcript()).messages.map((item) => item.role),
    ['user', 'assistant'],
  );
  assert.deepEqual(await client.memory(), { items: [] });
  const path = last.operations[0].source.split(' · ')[0];
  assert.match((await client.source(path)).content, /class SelectHistory/);
});
