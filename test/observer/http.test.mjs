import { ModelInteractions, ModelSource } from '@capix/observer-service';
import { createEnvironment } from '../fixtures/environment.mjs';
import { submissionSnapshot as submission, submissionSnapshots } from '../fixtures/submissions.mjs';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix/client-http';
import { ClientRuntime } from '@capix/client-runtime';
import { BoundRuntime, ProgressChannel, defineObservation } from '@capix/server-runtime';
import { createBoundRuntime } from '../fixtures/runtime.mjs';
import { readOutput, validateExecutionRecordSnapshot } from '@capix/protocol';
import { ConversationSubmission, createObserverServer, ObserverConversations, bindConversation, ConversationRuntimeDefinition, acceptConversationInput, DeepSeekProvider } from '@capix/observer-service';
import { withRuntimeDefinition } from '../fixtures/assembly.mjs';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 10000 };
const raw = (value) => ({ id: 'test', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const provider = {
  async invoke(_request, purpose) {
    return raw(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: '测试回答' });
  },
};
async function setup(t, model = provider, configured = true, submissionRetention, configuration = settings, configureDefinition) {
  const conversations = new ObserverConversations(model);
  const conversationId = conversations.list().defaultConversationId;
  const observer = withRuntimeDefinition(configureDefinition, () => conversations.open(conversationId));
  const server = createObserverServer({ conversations, settings: configuration, configured, submissionRetention });
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
  const get = (path) => {
    const url = new URL(path, base);
    if (['/api/conversation/admission', '/api/executions', '/api/execution', '/api/memory'].includes(url.pathname)) url.searchParams.set('conversationId', conversationId);
    if (url.pathname === '/api/transcript' && !url.searchParams.has('id')) url.searchParams.set('id', observer.transcript.id);
    return fetch(url)
      .then((response) => response.json())
      .then((value) => (url.pathname.startsWith('/api/submissions/') && !value.code ? submission(value) : value));
  };
  const run = (content = '测试输入', options = {}) => fetch(base + '/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...options.headers }, body: JSON.stringify({ conversationId, submissionId: options.id ?? randomUUID(), input: options.body ?? { messages: [{ role: 'user', content }] } }) });
  return { observer, conversations, conversationId, server, base, get, run };
}
const updates = async (response) => {
  const frames = (await response.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(frames[0].type, 'baseline');
  assert.ok(frames.every((frame) => ['baseline', 'submission', 'answer'].includes(frame.type)));
  return submissionSnapshots(frames);
};

test('HTTP overview exposes timing and associations without invocation bodies, while detail retains full records', async (t) => {
  const { get, run } = await setup(t);
  const response = await run();
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const stream = await updates(response);
  assert.ok(stream.length > 1);
  assert.ok(stream[0].input);
  assert.equal(stream.at(-1).result.status, 'completed');
  assert.equal(stream.at(-1).answer.index, 1);
  assert.equal(stream.at(-1).activities.integrity.status, 'complete');
  assert.deepEqual(new Set(stream.at(-1).activities.calls.map((call) => call.level)), new Set(['runtime', 'execution', 'operation', 'attempt']));
  assert.ok(stream.at(-1).activities.calls.every((call) => call.status === 'succeeded'));
  assert.ok(stream.every((item) => !('snapshot' in item)));
  const listed = await get('/api/executions');
  const snapshot = await get('/api/execution?id=' + listed.executions[0].id);
  validateExecutionRecordSnapshot(snapshot);
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
  for (const call of execution.calls) {
    const file = call.source.split(' · ')[0];
    const resolved = await get('/api/source?file=' + encodeURIComponent(file));
    assert.equal(resolved.path, file, `moved source must remain inspectable: ${call.source}`);
    assert.ok(resolved.content.length > 0);
  }
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
    const refused = submission(await busy.json());
    assert.equal(refused.result.status, 'rejected');
    assert.equal(refused.result.retry, 'admission');
    assert.equal(refused.admission.status, 'busy');
    assert.equal(refused.input, undefined);
    assert.equal(observer.transcript.length, 1);
    release();
    assert.equal((await updates(first)).at(-1).result.status, 'completed');
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
  assert.equal(stream.at(-1).result.status, 'failed');
  assert.equal(stream.at(-1).answer.index, 1);
  assert.equal(stream.at(-1).admission.status, 'ready');
  assert.equal((await get('/api/transcript')).messages[1].content, '测试回答');
  const { executions } = await get('/api/executions');
  assert.equal(executions[0].status, 'failed');
  assert.equal(executions[0].memoryStatus, 'failed');
  assert.deepEqual(executions[0].response, { index: 1 });
  const failed = executions[0].calls.filter((call) => call.status === 'failed');
  assert.deepEqual(
    failed.map((call) => call.label),
    ['执行调用', '提取记忆体', '请求模型', '发起模型调用'],
  );
  for (let index = 1; index < failed.length; index++) assert.equal(failed[index].parentId, failed[index - 1].id);
});

test('admission is a current hint while retained results keep their original facts', async (t) => {
  let release;
  let gated = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { run, get, observer } = await setup(t, {
    async invoke(request, purpose) {
      if (gated && purpose === 'answer') await gate;
      return provider.invoke(request, purpose);
    },
  });
  t.after(() => release());
  const id = 'already-completed';
  const finished = (await updates(await run('first', { id }))).at(-1);
  assert.deepEqual(await get('/api/conversation/admission'), { conversationId: (await get('/api/conversations')).defaultConversationId, transcriptId: observer.transcript.id, status: 'ready' });
  assert.equal(finished.admission.status, 'ready');
  gated = true;
  const second = await run('second');
  assert.equal((await get('/api/conversation/admission')).status, 'busy');
  assert.deepEqual(await get('/api/submissions/' + id), finished, 'a current condition does not rewrite a retained terminal snapshot');
  release();
  assert.equal((await updates(second)).at(-1).admission.status, 'ready');
});

test('unconfigured service refuses before input and queries never initialize the provider', async (t) => {
  let initialized = 0;
  const { run, get, observer } = await setup(
    t,
    () => {
      initialized += 1;
      return provider;
    },
    false,
  );
  const state = await get('/api/conversation/admission');
  assert.equal(state.status, 'unavailable');
  assert.equal(state.error.code, 'KEY_MISSING');
  const response = await run();
  assert.equal(response.status, 503);
  const refusal = submission(await response.json());
  assert.equal(refusal.result.status, 'rejected');
  assert.equal(refusal.result.retry, 'admission');
  assert.equal(refusal.admission.status, 'unavailable');
  assert.equal(observer.transcript.length, 0);
  assert.equal(initialized, 0);
});

test('known initialization failure stops later admission without probing or retrying construction', async (t) => {
  let initialized = 0;
  const { run, get, observer } = await setup(t, () => {
    initialized += 1;
    throw new Error('private constructor');
  });
  assert.equal((await get('/api/conversation/admission')).status, 'ready');
  assert.equal(initialized, 0);
  const failed = (await updates(await run())).at(-1);
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.admission.status, 'unavailable');
  assert.equal(failed.admission.error.code, 'MODEL_INITIALIZATION_FAILED');
  assert.equal(observer.transcript.length, 1);
  const refused = submission(await (await run()).json());
  assert.equal(refused.result.status, 'rejected');
  assert.equal(refused.result.retry, 'admission');
  assert.equal(observer.transcript.length, 1);
  assert.equal((await get('/api/conversation/admission')).status, 'unavailable');
  assert.equal(initialized, 1);
});

test('provider credential denial is known unavailable while transient HTTP failure remains ready', async (t) => {
  for (const status of [401, 403, 500]) {
    await t.test(String(status), async (t) => {
      let invoked = 0;
      const model = new DeepSeekProvider('fixture-key', async () => {
        invoked += 1;
        return new Response('', { status });
      });
      const { run, get, observer } = await setup(t, model);
      assert.equal((await get('/api/conversation/admission')).status, 'ready');
      assert.equal(invoked, 0);
      const failed = (await updates(await run())).at(-1);
      assert.equal(failed.result.status, 'failed');
      assert.equal(failed.admission.status, status === 500 ? 'ready' : 'unavailable');
      if (status !== 500) {
        assert.equal(failed.admission.error.code, `HTTP_${status}`);
        const refused = submission(await (await run()).json());
        assert.equal(refused.result.status, 'rejected');
        assert.equal(refused.result.retry, 'admission');
        assert.equal(observer.transcript.length, 1);
        assert.equal(invoked, 1);
      } else {
        await updates(await run());
        assert.equal(invoked, 2);
        assert.equal(observer.transcript.length, 2);
      }
    });
  }
});

test('provider body cleanup cannot erase known credential denial', async (t) => {
  const model = new DeepSeekProvider(
    'fixture-key',
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            throw new Error('cleanup failed');
          },
        }),
        { status: 401 },
      ),
  );
  const { run, get } = await setup(t, model);
  const failed = (await updates(await run())).at(-1);
  assert.equal(failed.result.error.code, 'HTTP_401');
  assert.equal(failed.admission.status, 'unavailable');
  assert.equal((await get('/api/conversation/admission')).error.code, 'HTTP_401');
});

test('single-call output length and invalid input leave admission ready', async (t) => {
  const { run, get } = await setup(t, {
    async invoke() {
      return { ...raw({}), finishReason: 'length' };
    },
  });
  const invalid = submission(await (await run('', { body: { messages: [{ role: 'assistant', content: 'invalid final role' }] } })).json());
  assert.equal(invalid.result.status, 'rejected');
  assert.equal(invalid.result.retry, undefined);
  assert.equal(invalid.admission.status, 'ready');
  const failed = (await updates(await run())).at(-1);
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.admission.status, 'ready');
  assert.equal((await get('/api/conversation/admission')).status, 'ready');
});

test('full feedback retention explicitly refuses fresh work and preserves duplicate and unknown semantics', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const { run, get, observer } = await setup(
    t,
    {
      async invoke(request, purpose) {
        if (purpose === 'answer') await gate;
        return provider.invoke(request, purpose);
      },
    },
    true,
    { maxEntries: 1 },
  );
  t.after(() => release());
  const first = await run('first', { id: 'retained-active' });
  const duplicate = await run('duplicate', { id: 'retained-active' });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'SUBMISSION_EXISTS');
  const refused = await run('capacity', { id: 'no-slot' });
  assert.equal(refused.status, 503);
  const snapshot = submission(await refused.json());
  assert.equal(snapshot.result.status, 'rejected');
  assert.equal(snapshot.result.error.code, 'SUBMISSION_CAPACITY');
  assert.equal(snapshot.result.retry, 'admission');
  assert.equal(snapshot.admission.status, 'busy');
  assert.equal(snapshot.input, undefined);
  assert.equal(observer.transcript.length, 1);
  assert.equal((await get('/api/submissions/no-slot')).code, 'SUBMISSION_UNAVAILABLE');
  release();
  const terminal = (await updates(first)).at(-1);
  assert.equal(terminal.admission.status, 'ready', 'the completing submission releases its retention slot before publishing admission');
  assert.equal((await get('/api/conversation/admission')).status, 'ready');
});

test('failure before a complete execution record produces a terminal transport error, never silent success', async (t) => {
  const { run } = await setup(t, provider, true, undefined, settings, (definition) => {
    definition.executionDefinition.entry.admit = () => {
      throw new Error('private diagnostic must not be an HTTP message');
    };
  });
  const stream = await updates(await run());
  assert.equal(stream.at(-1).input.end, 1);
  assert.equal(stream.at(-1).result.status, 'failed');
  assert.deepEqual(stream.at(-1).result.error, { code: 'INTERNAL_ERROR', message: '服务内部错误。' });
  assert.deepEqual(stream.at(-1).executions, []);
});

test('transport validates origin, input and source boundary before accepting work', async (t) => {
  const { run, base, observer, get } = await setup(t);
  assert.equal((await run('invalid origin', { headers: { Origin: 'https://outside.example' } })).status, 403);
  const invalid = await run('', { body: { messages: [{ role: 'assistant', content: 'invalid final role' }] } });
  assert.equal(invalid.status, 400);
  assert.equal(submission(await invalid.json()).result.error.code, 'INVALID_INPUT');
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
  assert.deepEqual(await get('/api/config'), { ...settings, configured: true });
});

test('separate HTTP subclasses deliver business content while records remain separately queryable', async (t) => {
  const { base, conversationId, observer } = await setup(t);
  const client = new ConversationHttpTransport(base);
  const observation = new ObservationHttpTransport(base);
  assert.deepEqual(await client.config(), { ...settings, configured: true });
  assert.deepEqual(await observation.overview(conversationId), { transcriptId: (await client.transcript(observer.transcript.id)).id, messages: [], executions: [] });
  const received = [];
  await client.submit(
    { conversationId, submissionId: randomUUID(), input: { messages: [{ role: 'user', content: '测试输入' }] } },
    (frame) => {
      if (frame.type !== 'answer') received.push(submission(frame, received.at(-1)));
    },
    new AbortController().signal,
  );
  assert.ok(received[0].input);
  assert.equal(received.at(-1).result.status, 'completed');
  const overview = await observation.overview(conversationId);
  const last = await observation.execution(conversationId, overview.executions[0].id);
  assert.equal(last.execution.status, 'succeeded');
  assert.equal(last.execution.contextId, received.at(-1).executions[0].contextId);
  assert.equal((await observation.overview(conversationId)).executions[0].response.index, 1);
  assert.deepEqual(
    (await client.transcript(observer.transcript.id)).messages.map((item) => item.role),
    ['user', 'assistant'],
  );
  assert.deepEqual(await observation.memory(conversationId), { items: [] });
  const path = last.operations[0].source.split(' · ')[0];
  assert.match((await observation.source(path)).content, /class SelectHistory/);
});

test('real HTTP headless client uses conversation only for two rounds without any observation requests', async (t) => {
  const { base, conversationId, observer } = await setup(t, provider, true);
  const paths = [];
  const http = new ConversationHttpTransport(base, (url, init) => {
    const path = new URL(url).pathname;
    paths.push(path);
    assert.ok(['/api/config', '/api/conversations', `/api/conversations/${conversationId}`, `/api/conversations/${conversationId}/submission`, '/api/conversation/admission', '/api/transcript', '/api/transcript/observe', '/api/run'].includes(path), path);
    return fetch(url, init);
  });
  const runtime = new ClientRuntime({ conversation: http, transcripts: http });
  t.after(() => runtime.stopTranscript());
  await runtime.initialize();
  await runtime.submit({ messages: [{ role: 'user', content: '第一问' }] });
  await runtime.submit({ messages: [{ role: 'user', content: '第二问' }] });
  await waitForClient(runtime, (state) => state.messages.length === 4);
  assert.equal(runtime.getSnapshot().messages.length, 4);
  assert.equal(runtime.getSnapshot().messages.at(-1).content, '测试回答');
  assert.equal(paths.filter((path) => path === '/api/run').length, 2);
  assert.equal(runtime.getSnapshot().observation.records.size, 0);
  const submissions = [...runtime.getSnapshot().submissions.values()];
  assert.equal(submissions.length, 2);
  for (const submission of submissions) {
    assert.equal(submission.remote.result.status, 'completed');
    assert.equal(submission.remote.activities.integrity.status, 'complete');
    assert.deepEqual(new Set(submission.remote.activities.calls.map((call) => call.level)), new Set(['runtime', 'execution', 'operation', 'attempt']));
    assert.ok(submission.remote.activities.calls.every((call) => call.status === 'succeeded'));
  }
});

test('answer is delivered before memory finishes, and closing observation does not cancel the conversation', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  const { base, conversationId, observer } = await setup(t, {
    async invoke(request, purpose) {
      if (purpose === 'memory') await gate;
      return provider.invoke(request, purpose);
    },
  });
  const controller = new AbortController();
  const observationResponse = await fetch(base + '/api/observe?conversationId=' + conversationId, { signal: controller.signal });
  assert.equal(observationResponse.status, 200);
  const reader = observationResponse.body.getReader();
  const client = new ConversationHttpTransport(base);
  let answerReady;
  const delivered = new Promise((resolve) => {
    answerReady = resolve;
  });
  const received = [];
  const run = client.submit(
    { conversationId, submissionId: randomUUID(), input: { messages: [{ role: 'user', content: '问题' }] } },
    (frame) => {
      if (frame.type === 'answer') return;
      const update = submission(frame, received.at(-1));
      received.push(update);
      if (update.answer) answerReady();
    },
    new AbortController().signal,
  );
  await delivered;
  assert.ok(received.at(-1).answer);
  assert.equal(received.at(-1).result, undefined);
  const chunk = await reader.read();
  assert.match(new TextDecoder().decode(chunk.value), /"type":"baseline"/);
  controller.abort();
  await reader.cancel().catch(() => {});
  release();
  await run;
  assert.equal(received.at(-1).result.status, 'completed');
});

test('the concrete conversation can deliver without a Recorder or any execution records', async () => {
  const entities = createEnvironment();
  const runtime = bindConversation(new ConversationRuntimeDefinition(), entities, new ModelInteractions(new ModelSource(provider)));
  const received = [];
  const output = await runtime.run(
    { messages: [{ role: 'user', content: '问题' }] },
    {
      settings,
      progress: new ProgressChannel({
        receive: (update) => {
          received.push(update);
        },
      }),
    },
  );
  assert.deepEqual(output, { kind: 'answer', content: '测试回答' });
  assert.deepEqual(
    received.map((item) => item.kind),
    ['input', 'execution', 'task', 'answer'],
  );
  assert.equal(received[0].range.transcriptId, entities.transcript.id);
  assert.equal(runtime.recorder, undefined);
  assert.equal(entities.transcript.length, 2);
});

test('HTTP client accepts the real answer index after an independent entity append during execution', async (t) => {
  let observer;
  const {
    base,
    conversationId,
    observer: environment,
  } = await setup(
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
  await waitForClient(runtime, (state) => state.messages.length === 3);
  assert.deepEqual(
    runtime.getSnapshot().messages.map((message) => message.content),
    ['本次输入', '运行期间独立追加', '正式回答'],
  );
  assert.equal(runtime.getSnapshot().messages[2].role, 'assistant');
  const overview = await new ObservationHttpTransport(base).overview(conversationId);
  assert.equal(overview.executions[0].inputIndex, 0);
  assert.equal(overview.executions[0].response.index, 2);
});

test('disconnecting submission delivery does not cancel work; reconnect reads the same task without a new model run', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  t.after(() => release());
  const { base, run, get, observer, conversations, conversationId } = await setup(t, {
    async invoke(request, purpose) {
      calls.push(purpose);
      if (purpose === 'selection') await gate;
      return provider.invoke(request, purpose);
    },
  });
  const id = randomUUID();
  const initial = await run('跨连接继续', { id });
  await initial.body.cancel();
  const pending = await get(`/api/submissions/${id}`);
  assert.equal(pending.input.end, 1);
  assert.equal(pending.result, undefined);
  assert.equal(observer.transcript.length, 1);
  const discovered = await get(`/api/conversations/${conversationId}/submission`);
  assert.equal(discovered.conversationId, conversationId);
  assert.equal(discovered.transcriptId, observer.transcript.id);
  assert.equal(discovered.submission.submission.submissionId, id);
  assert.deepEqual(discovered.submission.submission.input, pending.input);
  const other = conversations.create();
  assert.deepEqual(await get(`/api/conversations/${other.id}/submission`), { conversationId: other.id, transcriptId: other.transcriptId });
  const duplicate = await run('不得再次执行', { id });
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).code, 'SUBMISSION_EXISTS');
  const following = await fetch(`${base}/api/submissions/${id}/follow`);
  release();
  const frames = await updates(following);
  assert.equal(frames[0].submissionId, id);
  assert.equal(frames.at(-1).result.status, 'completed');
  assert.deepEqual(frames.at(-1).input, pending.input);
  assert.equal(frames.at(-1).answer.index, 1);
  assert.deepEqual(calls, ['selection', 'answer', 'memory']);
  assert.deepEqual(await get(`/api/submissions/${id}`), frames.at(-1));
  assert.equal(observer.transcript.length, 2);
  assert.equal((await get(`/api/conversations/${conversationId}/submission`)).submission, undefined);
  const late = await updates(await fetch(`${base}/api/submissions/${id}/follow`));
  assert.deepEqual(late, [frames.at(-1)]);
});

test('an unavailable submission is not reported as rejected or never executed', async (t) => {
  const { base, conversationId, observer } = await setup(t);
  const response = await fetch(`${base}/api/submissions/${randomUUID()}`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.code, 'SUBMISSION_UNAVAILABLE');
  assert.equal(body.result, undefined);
});

// Submission completion and entity synchronization are independent streams.
function waitForClient(runtime, predicate) {
  if (predicate(runtime.getSnapshot())) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      detach();
      reject(new Error('Client entity synchronization did not catch up'));
    }, 2000);
    const detach = runtime.subscribe(() => {
      if (!predicate(runtime.getSnapshot())) return;
      clearTimeout(deadline);
      detach();
      resolve();
    });
  });
}

test('invalid settings with a valid submission ID are retained as explicit rejection before runtime entry', async (t) => {
  let modelCalls = 0;
  const { run, get, observer, base } = await setup(
    t,
    {
      async invoke(request, purpose) {
        modelCalls++;
        return provider.invoke(request, purpose);
      },
    },
    true,
  );
  const id = randomUUID();
  const response = await run('invalid configuration', { id, body: { messages: [{ role: 'user', content: 'must not append' }], contextBudget: 0 } });
  assert.equal(response.status, 400);
  const rejected = submission(await response.json());
  assert.equal(rejected.submissionId, id);
  assert.equal(rejected.result.status, 'rejected');
  assert.equal(rejected.result.error.code, 'INVALID_SETTINGS');
  assert.deepEqual(await get(`/api/submissions/${id}`), rejected);
  assert.equal(observer.transcript.length, 0);
  assert.equal(modelCalls, 0);
  assert.equal(
    [...observer.book.values()].some((record) => record.kind === 'runtime-call'),
    false,
  );
  const transport = new ConversationHttpTransport(base);
  const runtime = new ClientRuntime({ conversation: transport, transcripts: transport });
  t.after(() => runtime.stopTranscript());
  await runtime.initialize();
  await assert.rejects(runtime.submit({ messages: [{ role: 'user', content: 'bad' }], contextBudget: 0 }), /容量预算/);
  assert.equal(runtime.getSnapshot().submission, undefined, 'local validation does not create remote work');
  assert.equal(runtime.getSnapshot().busy, false);
  await runtime.submit({ messages: [{ role: 'user', content: 'normal' }] });
  assert.equal(runtime.getSnapshot().submission.remote.result.status, 'completed');
});

test('HTTP cancellation retains an answer and waits for non-cooperating work before releasing runtime', async (t) => {
  let entered;
  const entering = new Promise((resolve) => {
    entered = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let modelSignal;
  const { base, run, observer } = await setup(t, {
    async invoke(request, purpose, signal) {
      if (purpose === 'memory') {
        modelSignal = signal;
        entered();
        await gate;
      }
      return provider.invoke(request, purpose);
    },
  });
  const id = randomUUID();
  const response = await run('已有回答后取消', { id });
  const delivery = updates(response);
  await entering;
  const client = new ConversationHttpTransport(base);
  const requested = submission(await client.cancel(id));
  assert.equal(requested.cancelRequested, true);
  assert.ok(requested.input);
  assert.ok(requested.answer);
  assert.equal(requested.result, undefined);
  assert.equal(modelSignal.aborted, true);
  assert.equal(observer.runtime.running, true);
  assert.equal(observer.transcript.length, 2);
  const duplicate = submission(await client.cancel(id));
  assert.deepEqual(duplicate, requested);
  const busy = await run('取消尚未结束不得执行');
  assert.equal(busy.status, 409);
  assert.equal(submission(await busy.json()).result.error.code, 'RUNTIME_BUSY');
  assert.equal(observer.transcript.length, 2);
  release();
  const frames = await delivery;
  const terminal = frames.at(-1);
  assert.equal(terminal.result.status, 'cancelled');
  assert.deepEqual(terminal.answer, requested.answer);
  assert.equal(observer.runtime.running, false);
  assert.equal(observer.transcript.length, 2);
  assert.equal(observer.memories.snapshot().length, 0);
  assert.deepEqual(submission(await client.read(id)), terminal);
  assert.deepEqual(submission(await client.cancel(id)), terminal);
  assert.equal((await updates(await run('下一次正常输入'))).at(-1).result.status, 'completed');
});

test('HTTP cancellation signals running model work independently of feedback connection lifetime', async (t) => {
  let entered;
  const entering = new Promise((resolve) => {
    entered = resolve;
  });
  const { base, run, observer } = await setup(t, {
    async invoke(_request, _purpose, signal) {
      entered();
      return new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  const id = randomUUID();
  const response = await run('取消调用', { id });
  await entering;
  await response.body.cancel();
  assert.equal(observer.runtime.running, true, 'disconnecting delivery does not request cancellation');
  const client = new ConversationHttpTransport(base);
  await client.cancel(id);
  const frames = [];
  await client.follow(
    id,
    (frame) => {
      if (frame.type !== 'answer') frames.push(submission(frame, frames.at(-1)));
    },
    new AbortController().signal,
  );
  assert.equal(frames.at(-1).result.status, 'cancelled');
  assert.equal(frames.at(-1).cancelRequested, true);
  assert.equal(observer.runtime.running, false);
  assert.equal(observer.transcript.length, 1);
});

test('unknown cancellation does not reserve an ID or prevent a later POST from executing', async (t) => {
  const { base, run } = await setup(t);
  const id = randomUUID();
  const client = new ConversationHttpTransport(base);
  await assert.rejects(client.cancel(id), (error) => error.code === 'SUBMISSION_UNAVAILABLE' && error.response.status === 404);
  const terminal = (await updates(await run('稍后到达的提交', { id }))).at(-1);
  assert.equal(terminal.result.status, 'completed');
  assert.equal(terminal.cancelRequested, undefined);
  assert.deepEqual(submission(await client.cancel(id)), terminal);
});

test('cancel requires same-origin JSON and validates its empty body before changing work', async (t) => {
  const { base, conversationId, observer } = await setup(t);
  const url = `${base}/api/submissions/${randomUUID()}/cancel`;
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json', Origin: 'https://other.test' }]) {
    const response = await fetch(url, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 403);
  }
  for (const body of ['{', '{"input":"not a cancellation field"}']) {
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).result, undefined);
  }
});

for (const fault of [false, true]) {
  test(`cancellation between A1 return and A2 creation ${fault ? 'preserves the structural failure' : 'drains before the service terminal result'}`, async (t) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let pending;
    const returned = new Promise((resolve) => {
      pending = resolve;
    });
    let capturedSubmission;
    const originalStart = ConversationSubmission.prototype.start;
    t.mock.method(ConversationSubmission.prototype, 'start', function (work) {
      capturedSubmission = this;
      return originalStart.call(this, work);
    });
    const { observer, run, get } = await setup(
      t,
      {
        async invoke(request, purpose) {
          if (purpose === 'selection') await gate;
          return provider.invoke(request, purpose);
        },
      },
      true,
      undefined,
      { ...settings, timeoutMs: 1000 },
      (definition) => {
        const model = definition.executionDefinition.operationDefinitions.selection.requestModelDefinition;
        model.observation = [
          ...model.observation,
          defineObservation(
            {
              requires: {},
              observe(fact) {
                if (fact.kind !== 'relation' || fact.change.kind !== 'returned' || fact.change.result.status !== 'succeeded' || fact.change.result.output.kind !== 'pending') return;
                // The public cancellation entry is invoked at the exact synchronous handoff boundary.
                capturedSubmission.requestCancellation();
                pending();
                if (fault) throw new Error('handoff observer fault');
              },
            },
            { failure: 'propagate' },
          ),
        ];
      },
    );
    const id = randomUUID();
    const stream = updates(await run('交接处取消', { id }));
    try {
      await returned;
      const interim = await get(`/api/submissions/${id}`);
      assert.equal(observer.runtime.running, false, 'the R invocation has genuinely ended');
      assert.equal(observer.interactions.active, true);
      assert.equal(observer.interactions.cancelling, true);
      assert.equal(interim.cancelRequested, true);
      if (fault) {
        assert.equal(interim.result.status, 'failed');
        assert.notEqual(interim.result.status, 'cancelled');
      } else assert.equal(interim.result, undefined, 'service cancellation is still draining its external owner');
      assert.equal((await get('/api/conversation/admission')).status, 'busy');
      const blocked = await run('暂不接纳新的 QA');
      assert.equal(blocked.status, 409);
      assert.equal(submission(await blocked.json()).result.retry, 'admission');
      assert.equal(observer.transcript.length, 1);
      release();
      await observer.interactions.settled();
      const completed = (await stream).at(-1);
      assert.equal(completed.result.status, fault ? 'failed' : 'cancelled');
      assert.equal((await get('/api/conversation/admission')).status, 'ready');
      assert.equal(observer.interactions.cancelling, false);
      assert.equal(observer.transcript.length, 1);
    } finally {
      release();
      await observer.interactions.settled();
      await stream;
    }
  });
}
