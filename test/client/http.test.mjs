import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpTransport, ConversationHttpTransport, ObservationHttpTransport, HttpError, HttpTransportError } from '@capix/client-http';
import { snapshot, transcriptSnapshot, baseline } from './fixtures.mjs';

const input = { messages: [{ role: 'user', content: '测试' }] };
const started = { type: 'started', contextId: 'context', transcriptId: 'fixture-transcript', inputIndex: 0 };
const answer = { type: 'answer', contextId: 'context', transcriptId: 'fixture-transcript', index: 1, output: { kind: 'answer', content: '回答' } };
const completed = { type: 'completed', contextId: 'context' };
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

test('Observer HTTP rejection retains server code and does not deliver acceptance or retry', async () => {
  let calls = 0;
  const body = { code: 'BUSY', error: '当前忙碌' };
  const client = new ConversationHttpTransport('', async () => {
    calls++;
    return Response.json(body, { status: 409 });
  });
  await assert.rejects(
    client.run(
      input,
      () => assert.fail('No snapshot'),
      () => assert.fail('Not accepted'),
    ),
    (error) => {
      assert.ok(error instanceof HttpError);
      assert.equal(error.response.status, 409);
      assert.equal(error.response.method, 'POST');
      assert.equal(error.code, 'BUSY');
      assert.equal(error.message, '当前忙碌');
      assert.deepEqual(error.body, body);
      return true;
    },
  );
  assert.equal(calls, 1);
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

test('stream remote errors retain their server code', async () => {
  const client = new ConversationHttpTransport('', async () => new Response(JSON.stringify({ type: 'error', error: '发布失败', code: 'PUBLICATION_ERROR' })));
  await assert.rejects(
    client.run(
      input,
      () => {},
      () => {},
    ),
    (error) => error instanceof HttpTransportError && error.kind === 'remote' && error.code === 'PUBLICATION_ERROR',
  );
});

test('malformed JSON and terminal regression are rejected before invalid delivery', async () => {
  let received = 0;
  const client = new ConversationHttpTransport('', async () => new Response(`${line(started)}\n${line(answer)}\n${line(completed)}\n${line(started)}\n`));
  await assert.rejects(
    client.run(
      input,
      () => {
        received++;
      },
      () => {},
    ),
    (error) => error.code === 'AFTER_TERMINAL',
  );
  assert.equal(received, 3);
  const malformed = new ConversationHttpTransport('', async () => new Response('{"type":'));
  await assert.rejects(
    malformed.run(
      input,
      () => {},
      () => {},
    ),
    (error) => error.kind === 'contract' && error.code === 'INVALID_JSON' && error.cause instanceof SyntaxError,
  );
});

test('acceptance callback failure closes the unconsumed body and preserves its cause', async () => {
  let cancelled = false;
  const cause = new Error('local acceptance failed');
  const body = new ReadableStream({
    cancel() {
      cancelled = true;
    },
  });
  const client = new ConversationHttpTransport('', async () => new Response(body));
  await assert.rejects(
    client.run(
      input,
      () => {},
      () => {
        throw cause;
      },
    ),
    (error) => error.kind === 'delivery' && error.cause === cause,
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('business callback failure closes the active reader and is distinguishable from network failure', async () => {
  let cancelled = false;
  const cause = new Error('local delivery failed');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(line(started) + '\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new ConversationHttpTransport('', async () => new Response(body));
  await assert.rejects(
    client.run(
      input,
      () => {
        throw cause;
      },
      () => {},
    ),
    (error) => error.kind === 'delivery' && error.cause === cause,
  );
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  const networkCause = new TypeError('network disconnected');
  const broken = new ConversationHttpTransport(
    '',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(networkCause);
          },
        }),
      ),
  );
  await assert.rejects(
    broken.run(
      input,
      () => {},
      () => {},
    ),
    (error) => error === networkCause,
  );
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

test('conversation delivery cannot silently change transcript identity between started and answer', async () => {
  const client = new ConversationHttpTransport('', async () => new Response([started, { ...answer, transcriptId: 'other' }].map(line).join('\n')));
  await assert.rejects(
    client.run(
      input,
      () => {},
      () => {},
    ),
    (error) => error.code === 'TRANSCRIPT_MISMATCH',
  );
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
