import { createEnvironment } from '../fixtures/environment.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix-observer/client-http';
import { ClientRuntime } from '@capix-observer/client-runtime';
import { Runtime } from '@capix-observer/runtime';
import { createRuntime } from '../fixtures/runtime.mjs';
import { readOutput, validateSnapshot } from '@capix-observer/protocol';
import { createObserverServer, initializeObserver, bindObserver, ObserverRuntimeDefinition, acceptExecutionInput } from '@capix-observer/service';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 10000 };
const raw = (value) => ({ id: 'test', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const provider = {
  async invoke(_request, purpose) {
    return raw(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: '测试回答' });
  },
};
async function setup(t, model = provider, configured = false) {
  const observer = initializeObserver(model);
  const server = createObserverServer({ observer, settings, configured });
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
  assert.deepEqual(
    stream.map((item) => item.type),
    ['started', 'answer', 'completed'],
  );
  assert.ok(stream.every((item) => !('snapshot' in item)));
  const listed = await get('/api/executions');
  const snapshot = await get('/api/execution?id=' + listed.executions[0].id);
  validateSnapshot(snapshot);
  assert.equal(snapshot.execution.status, 'succeeded');
  assert.equal(readOutput(snapshot.execution.value).content, '测试回答');
  const overview = await get('/api/executions');
  assert.equal(overview.executions.length, 1);
  assert.deepEqual(
    overview.messages.map(({ index }) => index),
    [0, 1],
  );
  assert.ok(overview.messages.every((item) => !('message' in item)));
  const execution = overview.executions[0];
  assert.equal(execution.calls.length, 1 + snapshot.operations.length + snapshot.attempts.length);
  assert.deepEqual(execution.transcriptRange, { transcriptId: overview.transcriptId, start: 0, end: 1, revision: 1 });
  assert.deepEqual(execution.availableMemoryIds, []);
  assert.deepEqual(execution.response, { index: 1 });
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
    assert.equal((await updates(first)).at(-1).type, 'completed');
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
  assert.deepEqual(
    stream.map((item) => item.type),
    ['started', 'answer', 'error'],
  );
  assert.equal(stream[1].output.content, '测试回答');
  const { executions } = await get('/api/executions');
  assert.equal(executions[0].status, 'failed');
  assert.equal(executions[0].memoryStatus, 'failed');
  assert.deepEqual(executions[0].response, { index: 1 });
  assert.equal(executions[0].calls.filter((call) => call.status === 'failed').length, 3);
});

test('failure before a complete execution record produces a terminal transport error, never silent success', async (t) => {
  const { run, observer } = await setup(t);
  observer.definition.execution.entry.admit = () => {
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
  assert.equal(
    [...observer.book.values()].some((record) => record.kind === 'execution'),
    false,
    'rejected E input creates no QA',
  );
  const failedRuntime = [...observer.book.values()].find((record) => record.kind === 'runtime-call');
  assert.equal(failedRuntime.status, 'failed', 'R records the rejected child admission');
  assert.equal(observer.recording.root.childIds.includes(failedRuntime.id), true);
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

test('separate HTTP subclasses deliver business content while records remain separately queryable', async (t) => {
  const { base } = await setup(t);
  const client = new ConversationHttpTransport(base);
  const observation = new ObservationHttpTransport(base);
  assert.deepEqual(await client.config(), { ...settings, configured: false });
  assert.deepEqual(await observation.overview(), { transcriptId: (await client.transcript()).id, messages: [], executions: [] });
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
  assert.deepEqual(
    received.map((item) => item.type),
    ['started', 'answer', 'completed'],
  );
  const overview = await observation.overview();
  const last = await observation.execution(overview.executions[0].id);
  assert.equal(last.execution.status, 'succeeded');
  assert.equal(last.execution.contextId, received[0].contextId);
  assert.equal((await observation.overview()).executions[0].response.index, 1);
  assert.deepEqual(
    (await client.transcript()).messages.map((item) => item.role),
    ['user', 'assistant'],
  );
  assert.deepEqual(await observation.memory(), { items: [] });
  const path = last.operations[0].source.split(' · ')[0];
  assert.match((await observation.source(path)).content, /class SelectHistory/);
});

test('real HTTP headless client uses conversation only for two rounds without any observation requests', async (t) => {
  const { base } = await setup(t, provider, true);
  const paths = [];
  const http = new ConversationHttpTransport(base, (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    assert.ok(['/api/config', '/api/transcript', '/api/transcript/observe', '/api/run'].includes(path), path);
    return fetch(url, init);
  });
  const runtime = new ClientRuntime({ conversation: http, transcripts: http });
  t.after(() => runtime.stopTranscript());
  await runtime.initialize();
  await runtime.submit({ messages: [{ role: 'user', content: '第一问' }] });
  await runtime.submit({ messages: [{ role: 'user', content: '第二问' }] });
  assert.equal(runtime.getSnapshot().messages.length, 4);
  assert.equal(runtime.getSnapshot().messages.at(-1).content, '测试回答');
  assert.equal(paths.filter((path) => path === '/api/run').length, 2);
  assert.equal(runtime.getSnapshot().observation.records.size, 0);
});

test('answer is delivered before memory finishes, and closing observation does not cancel the conversation', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const { base } = await setup(t, {
    async invoke(request, purpose) {
      if (purpose === 'memory') await gate;
      return provider.invoke(request, purpose);
    },
  });
  const controller = new AbortController();
  const observationResponse = await fetch(base + '/api/observe', { signal: controller.signal });
  assert.equal(observationResponse.status, 200);
  const reader = observationResponse.body.getReader();
  const client = new ConversationHttpTransport(base);
  let answerReady;
  const delivered = new Promise((resolve) => {
    answerReady = resolve;
  });
  const received = [];
  const run = client.run(
    { messages: [{ role: 'user', content: '问题' }] },
    (update) => {
      received.push(update);
      if (update.type === 'answer') answerReady();
    },
    () => {},
  );
  await delivered;
  assert.deepEqual(
    received.map((item) => item.type),
    ['started', 'answer'],
  );
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /"type":"baseline"/);
  controller.abort();
  await reader.cancel().catch(() => {});
  release();
  await run;
  assert.equal(received.at(-1).type, 'completed');
});

test('the concrete conversation can deliver without a Recorder or any execution records', async () => {
  const entities = createEnvironment();
  const runtime = bindObserver(new ObserverRuntimeDefinition(), entities, provider);
  const received = [];
  const output = await runtime.run({ messages: [{ role: 'user', content: '问题' }] }, { settings, deliver: (update) => received.push(update) });
  assert.deepEqual(output, { kind: 'answer', content: '测试回答' });
  assert.deepEqual(
    received.map((item) => item.type),
    ['answer'],
  );
  assert.equal(received[0].transcriptId, entities.transcript.id);
  assert.equal(runtime.recorder, undefined);
  assert.equal(entities.transcript.length, 2);
});

test('HTTP client accepts the real answer index after an independent entity append during execution', async (t) => {
  let observer;
  const { base, observer: environment } = await setup(
    t,
    {
      async invoke(_request, purpose) {
        if (purpose === 'answer') {
          observer.transcript.append({ role: 'user', content: '运行期间独立追加' });
        }
        return raw(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: '正式回答' });
      },
    },
    true,
  );
  observer = environment;
  const http = new ConversationHttpTransport(base);
  const runtime = new ClientRuntime({ conversation: http, transcripts: http });
  t.after(() => runtime.stopTranscript());
  await runtime.initialize();
  await runtime.submit({ messages: [{ role: 'user', content: '本次输入' }] });
  assert.equal(runtime.getSnapshot().answered, true);
  assert.deepEqual(
    runtime.getSnapshot().messages.map((message) => message.content),
    ['本次输入', '运行期间独立追加', '正式回答'],
  );
  assert.equal(runtime.getSnapshot().messages[2].role, 'assistant');
  const overview = await new ObservationHttpTransport(base).overview();
  assert.equal(overview.executions[0].inputIndex, 0);
  assert.equal(overview.executions[0].response.index, 2);
});
