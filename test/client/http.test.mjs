import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpTransport, ConversationHttpTransport, ObservationHttpTransport, HttpError, HttpTransportError } from '@capix/client-http';
import { snapshot, transcriptSnapshot, baseline, submissionSnapshot } from './fixtures.mjs';

const input = { messages: [{ role: 'user', content: '测试' }] };
const request = { submissionId: 'submission', input };
const initial = submissionSnapshot('submission');
const signal = () => new AbortController().signal;
const line = (value) => JSON.stringify(value);
const jsonConversation = (value) => new ConversationHttpTransport('', async () => Response.json(value));
const jsonObservation = (value) => new ObservationHttpTransport('', async () => Response.json(value));

test('HTTP base supports a different API without Observer endpoints or response types', async () => {
  class CatalogClient extends HttpTransport {
    list() {
      return this.get('/catalog');
    }
  }
  const urls = [];
  const client = new CatalogClient('http://example.test/service/', async (url) => {
    urls.push(url);
    return Response.json({ products: ['book'] });
  });
  assert.deepEqual(await client.list(), { products: ['book'] });
  assert.deepEqual(urls, ['http://example.test/service/catalog']);
  assert.equal('overview' in client, false);
});

test('HTTP failures retain status, method, URL and non-JSON body', async () => {
  for (const body of ['', '<html>Bad Gateway</html>']) {
    const client = new ObservationHttpTransport('http://example.test', async () => new Response(body, { status: 502 }));
    await assert.rejects(client.overview(), (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.phase, 'status');
      assert.deepEqual(error.response, { status: 502, method: 'GET', url: 'http://example.test/api/executions' });
      assert.equal(error.body, body);
      assert.equal(error.message, 'HTTP 502');
      return true;
    });
  }
});

test('invalid successful JSON is a decode failure with its response and cause preserved', async () => {
  const client = new ConversationHttpTransport('', async () => new Response('not json'));
  await assert.rejects(client.config(), (error) => {
    assert.ok(error instanceof HttpError);
    assert.equal(error.phase, 'decode');
    assert.equal(error.response.status, 200);
    assert.equal(error.body, 'not json');
    assert.ok(error.cause instanceof SyntaxError);
    return true;
  });
});

test('all Observer queries reject malformed success bodies at the response boundary', async () => {
  const conversation = jsonConversation({ unexpected: true });
  const observation = jsonObservation({ unexpected: true });
  for (const [client, method, args] of [
    [conversation, 'config', []],
    [conversation, 'transcript', []],
    [observation, 'overview', []],
    [observation, 'memory', []],
    [observation, 'source', ['x.ts']],
    [observation, 'execution', ['e']],
  ]) {
    await assert.rejects(client[method](...args), (error) => error instanceof HttpTransportError && error.kind === 'contract', method);
  }
});

test('Observer queries accept declared fields without coercing malformed nested data', async () => {
  const config = { model: 'fixture', configured: true, contextBudget: 32768, maxOutputTokens: 1024, timeoutMs: 30000 };
  assert.deepEqual(await jsonConversation(config).config(), config);
  assert.deepEqual(await jsonConversation(transcriptSnapshot(input.messages)).transcript(), transcriptSnapshot(input.messages));
  assert.deepEqual(await jsonObservation({ transcriptId: 'fixture-transcript', executions: [], messages: [] }).overview(), { transcriptId: 'fixture-transcript', executions: [], messages: [] });
  assert.deepEqual(await jsonObservation({ items: [] }).memory(), { items: [] });
  await assert.rejects(jsonConversation({ ...config, contextBudget: '32768' }).config(), /响应格式无效/);
  await assert.rejects(jsonConversation({ messages: [{ role: 'system', content: 'invalid' }] }).transcript(), /响应格式无效/);
  await assert.rejects(jsonObservation({ executions: [], messages: [{ index: -1, count: 0, message: input.messages[0] }] }).overview(), /响应格式无效/);
  await assert.rejects(jsonObservation({ items: [{ id: 'm', topic: '主题', content: '内容', sources: [], records: [{ id: 'r' }] }] }).memory(), /响应格式无效/);
});

test('record and source query responses must match the requested identity', async () => {
  await assert.rejects(jsonObservation(snapshot()).execution('different'), (error) => error.code === 'EXECUTION_MISMATCH');
  await assert.rejects(jsonObservation({ path: 'different.ts', content: 'source' }).source('requested.ts'), (error) => error.code === 'SOURCE_MISMATCH');
});

test('execution details require the actual parent R record and its independent boundaries', async () => {
  for (const field of ['runtimeCall', 'runtimeEvents']) {
    const incomplete = snapshot();
    delete incomplete[field];
    await assert.rejects(jsonObservation(incomplete).execution(incomplete.execution.id), (error) => error.code === 'INVALID_SNAPSHOT');
  }
});

test('entity queries validate the requested UID and entity streams preserve revisions and origin', async () => {
  await assert.rejects(jsonConversation(transcriptSnapshot([], 'other')).transcript('requested'), (error) => error.code === 'TRANSCRIPT_MISMATCH');
  const baseline = { type: 'baseline', snapshot: transcriptSnapshot([], 't', 0) };
  const delta = { type: 'delta', event: { type: 'transcript', transcriptId: 't', revision: 1, occurredAt: '2026-10-09T00:00:00Z', origin: { contextId: 'context' }, change: { kind: 'messages-appended', start: 0, messages: input.messages } } };
  let url;
  const client = new ConversationHttpTransport('http://example.test', async (value) => {
    url = value;
    return new Response([baseline, delta].map(line).join('\n'));
  });
  const received = [];
  await assert.rejects(
    client.observeTranscript('t', (frame) => received.push(frame), new AbortController().signal),
    (error) => error.code === 'INCOMPLETE_STREAM',
  );
  assert.equal(url, 'http://example.test/api/transcript/observe?id=t');
  assert.deepEqual(received, [baseline, delta]);
});

test('observation delivery preserves E entry diagnostics and parent relationship failure evidence', async () => {
  const occurredAt = '2026-10-09T00:00:00Z';
  const error = { code: 'ENTRY_TEST', message: 'entry delivery failed' };
  const invocation = { type: 'invocation', contextId: 'runtime-context', level: 'runtime', occurredAt };
  const changes = ['accept', 'notification', 'admit', 'capture'].map((stage, index) => ({ ...invocation, sequence: index + 2, change: { kind: 'entry', target: 'execution', instanceId: 'execution-instance', key: 'main', stage, status: stage === 'notification' ? 'failed' : 'accepted', ...(stage === 'notification' ? { error } : {}) } }));
  changes.push({ type: 'record', recorderId: 'fixture-recorder', revision: 1, occurredAt, change: { kind: 'relation-appended', id: 'runtime-call', relation: { identity: { parentContextId: 'runtime-context', childContextId: 'child-context', parentRound: 0 }, eventSequence: 6, occurredAt, offsetMs: 10, childId: 'child-call', change: { kind: 'failed', source: 'observation', error } } } });
  const frames = [baseline({ invocations: [{ ...invocation, sequence: 1, change: { kind: 'started' } }] }), { type: 'delta', scopeId: 'fixture-scope', sequence: 1, changes }];
  const received = [];
  const client = new ObservationHttpTransport('', async () => new Response(frames.map(line).join('\n')));
  await assert.rejects(
    client.observe((frame) => received.push(frame), new AbortController().signal),
    (error) => error.code === 'INCOMPLETE_STREAM',
  );
  assert.deepEqual(received, frames);
});

test('HTTP known rejection is accepted as a formal snapshot without replaying submission', async () => {
  let calls = 0;
  const rejected = submissionSnapshot('submission', { revision: 1, result: { status: 'rejected', error: { code: 'BUSY', message: '当前忙碌' } } });
  const io = new ConversationHttpTransport('', async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body), request);
    assert.equal(init.signal.aborted, false);
    return Response.json(rejected, { status: 409 });
  });
  const values = [];
  await io.submit(request, (value) => values.push(value), signal());
  assert.deepEqual(values, [rejected]);
  assert.equal(calls, 1);
});

test('unknown HTTP failures and unavailable follow preserve uncertainty and diagnosis', async () => {
  const io = new ConversationHttpTransport('', async () => Response.json({ code: 'SUBMISSION_UNAVAILABLE', error: 'unavailable' }, { status: 404 }));
  await assert.rejects(
    io.follow('submission', () => assert.fail('No remote facts'), signal()),
    (error) => error instanceof HttpError && error.code === 'SUBMISSION_UNAVAILABLE' && error.response.status === 404,
  );
  const other = new ConversationHttpTransport('', async () => Response.json(submissionSnapshot('foreign', { result: { status: 'rejected', error: { code: 'BUSY', message: 'busy' } } }), { status: 409 }));
  await assert.rejects(
    other.submit(request, () => assert.fail('foreign'), signal()),
    (error) => error.code === 'SUBMISSION_MISMATCH',
  );
});

test('follow and read use the same submission identity and never post again', async () => {
  const terminal = submissionSnapshot('a/b', { revision: 8, result: { status: 'completed' } });
  const requests = [];
  const io = new ConversationHttpTransport('http://example.test', async (url, init) => {
    requests.push([url, init.method ?? 'GET']);
    return Response.json(terminal);
  });
  const values = [];
  await io.follow('a/b', (value) => values.push(value), signal());
  assert.deepEqual(await io.read('a/b'), terminal);
  assert.deepEqual(values, [terminal]);
  assert.deepEqual(requests, [
    ['http://example.test/api/submissions/a%2Fb/follow', 'GET'],
    ['http://example.test/api/submissions/a%2Fb', 'GET'],
  ]);
});

test('malformed submission feedback is rejected before delivery', async () => {
  for (const body of ['{"submissionId":', line({ ...initial, revision: 1.5 }), line({ ...initial, answer: { transcriptId: 't', index: -1 } })]) {
    const io = new ConversationHttpTransport('', async () => new Response(body));
    await assert.rejects(
      io.submit(request, () => assert.fail('invalid'), signal()),
      (error) => error.kind === 'contract',
    );
  }
});

test('feedback consumer failure closes the active reader and retains the cause', async () => {
  let cancelled = false;
  const cause = new Error('consumer');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(line(initial) + '\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const io = new ConversationHttpTransport('', async () => new Response(body));
  await assert.rejects(
    io.submit(
      request,
      () => {
        throw cause;
      },
      signal(),
    ),
    (error) => error.kind === 'delivery' && error.cause === cause,
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('terminal snapshot ends feedback consumption without requiring socket EOF', async () => {
  let cancelled = false;
  const terminal = { ...initial, revision: 1, result: { status: 'completed' } };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(line(terminal) + '\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const io = new ConversationHttpTransport('', async () => new Response(body));
  const values = [];
  await io.submit(request, (value) => values.push(value), signal());
  assert.deepEqual(values, [terminal]);
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});
