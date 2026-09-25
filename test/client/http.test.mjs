import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpTransport, ObserverHttpTransport, HttpError, ObserverTransportError } from '@capix-observer/client-http';
import { snapshot } from './fixtures.mjs';

const input = { messages: [{ role: 'user', content: '测试' }] };
const line = (value) => JSON.stringify({ type: 'snapshot', snapshot: value });
const jsonTransport = (value) => new ObserverHttpTransport('', async () => Response.json(value));

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
    const client = new ObserverHttpTransport('http://example.test', async () => new Response(body, { status: 502 }));
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
  const client = new ObserverHttpTransport('', async () => {
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
  const client = new ObserverHttpTransport('', async () => new Response('not json'));
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
  const client = jsonTransport({ unexpected: true });
  for (const [method, args] of [
    ['config', []],
    ['overview', []],
    ['transcript', []],
    ['memory', []],
    ['source', ['x.ts']],
    ['execution', ['e']],
  ]) {
    await assert.rejects(client[method](...args), (error) => error instanceof ObserverTransportError && error.kind === 'contract', method);
  }
});

test('Observer queries accept declared fields without coercing malformed nested data', async () => {
  const config = { model: 'fixture', configured: true, contextBudget: 32768, maxOutputTokens: 1024, timeoutMs: 30000 };
  assert.deepEqual(await jsonTransport(config).config(), config);
  assert.deepEqual(await jsonTransport({ messages: input.messages }).transcript(), { messages: input.messages });
  assert.deepEqual(await jsonTransport({ executions: [], messages: [] }).overview(), { executions: [], messages: [] });
  assert.deepEqual(await jsonTransport({ items: [] }).memory(), { items: [] });
  await assert.rejects(jsonTransport({ ...config, contextBudget: '32768' }).config(), /响应格式无效/);
  await assert.rejects(jsonTransport({ messages: [{ role: 'system', content: 'invalid' }] }).transcript(), /响应格式无效/);
  await assert.rejects(jsonTransport({ executions: [], messages: [{ index: -1, count: 0, message: input.messages[0] }] }).overview(), /响应格式无效/);
  await assert.rejects(jsonTransport({ items: [{ id: 'm', topic: '主题', content: '内容', sources: [], records: [{ id: 'r' }] }] }).memory(), /响应格式无效/);
});

test('record and source query responses must match the requested identity', async () => {
  await assert.rejects(jsonTransport(snapshot()).execution('different'), (error) => error.code === 'EXECUTION_MISMATCH');
  await assert.rejects(jsonTransport({ path: 'different.ts', content: 'source' }).source('requested.ts'), (error) => error.code === 'SOURCE_MISMATCH');
});

test('stream remote errors retain their server code', async () => {
  const client = new ObserverHttpTransport('', async () => new Response(JSON.stringify({ type: 'error', error: '发布失败', code: 'PUBLICATION_ERROR' })));
  await assert.rejects(
    client.run(
      input,
      () => {},
      () => {},
    ),
    (error) => error instanceof ObserverTransportError && error.kind === 'remote' && error.code === 'PUBLICATION_ERROR',
  );
});

test('malformed JSON and terminal regression are rejected before invalid delivery', async () => {
  let received = 0;
  const client = new ObserverHttpTransport('', async () => new Response(`${line(snapshot())}\n${line(snapshot('running'))}\n`));
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
  assert.equal(received, 1);
  const malformed = new ObserverHttpTransport('', async () => new Response('{"type":'));
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
  const client = new ObserverHttpTransport('', async () => new Response(body));
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

test('snapshot callback failure closes the active reader and is distinguishable from network failure', async () => {
  let cancelled = false;
  const cause = new Error('local snapshot failed');
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(line(snapshot('running')) + '\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new ObserverHttpTransport('', async () => new Response(body));
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
  const broken = new ObserverHttpTransport(
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
