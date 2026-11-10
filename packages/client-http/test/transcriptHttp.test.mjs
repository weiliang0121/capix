import test from 'node:test';

import assert from 'node:assert/strict';

import { ConversationHttpTransport, HttpError, HttpTransportError } from '@capix/client-http';

import { TranscriptConnectionError } from '@capix/client-runtime';

import { transcriptSnapshot } from './fixtures.mjs';

const baseline = { type: 'baseline', snapshot: transcriptSnapshot([], 'transcript', 0) };

const signal = () => new AbortController().signal;

test('transcript connection failures retain network and stream read causes', async () => {
  const network = new TypeError('Failed to fetch');
  const disconnected = new ConversationHttpTransport('', async () => {
    throw network;
  });
  await assert.rejects(
    disconnected.observeTranscript('transcript', () => {}, signal()),
    (error) => error instanceof TranscriptConnectionError && error.cause === network && error.message === network.message,
  );

  const interrupted = new TypeError('terminated');
  let reader;
  const stream = new ReadableStream({
    start(controller) {
      reader = controller;
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(baseline)}\n`));
    },
  });
  const client = new ConversationHttpTransport('', async () => new Response(stream));
  const received = [];
  await assert.rejects(
    client.observeTranscript(
      'transcript',
      (frame) => {
        received.push(frame);
        reader.error(interrupted);
      },
      signal(),
    ),
    (error) => error instanceof TranscriptConnectionError && error.cause === interrupted,
  );
  assert.deepEqual(received, [baseline]);
  assert.equal(stream.locked, false);
});

test('only temporary transcript HTTP statuses request connection recovery and preserve HTTP facts', async () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    const body = { code: 'TEMPORARY', error: 'service temporarily unavailable' };
    const client = new ConversationHttpTransport('http://example.test', async () => Response.json(body, { status }));
    await assert.rejects(
      client.observeTranscript('transcript', () => {}, signal()),
      (error) => {
        assert.ok(error instanceof TranscriptConnectionError);
        assert.ok(error.cause instanceof HttpError);
        assert.equal(error.cause.phase, 'status');
        assert.deepEqual(error.cause.response, { method: 'GET', url: 'http://example.test/api/transcript/observe?id=transcript', status });
        assert.deepEqual(error.cause.body, body);
        assert.equal(error.cause.code, 'TEMPORARY');
        assert.equal(error.message, body.error);
        return true;
      },
    );
  }
  for (const status of [400, 401, 403, 404, 409, 422, 501]) {
    const client = new ConversationHttpTransport('', async () => new Response('', { status }));
    await assert.rejects(
      client.observeTranscript('transcript', () => {}, signal()),
      (error) => error instanceof HttpError && error.response.status === status,
    );
  }
});

test('unexpected transcript EOF is recoverable without losing the incomplete-stream diagnosis', async () => {
  const client = new ConversationHttpTransport('', async () => new Response(JSON.stringify(baseline)));
  const received = [];
  await assert.rejects(
    client.observeTranscript('transcript', (frame) => received.push(frame), signal()),
    (error) => {
      assert.ok(error instanceof TranscriptConnectionError);
      assert.ok(error.cause instanceof HttpTransportError);
      assert.equal(error.cause.kind, 'contract');
      assert.equal(error.cause.code, 'INCOMPLETE_STREAM');
      return true;
    },
  );
  assert.deepEqual(received, [baseline]);
});

test('transcript source, JSON and contract failures do not masquerade as transient transport failures', async () => {
  for (const code of ['SOURCE_INCOMPLETE', 'INCOMPLETE_STREAM']) {
    const client = new ConversationHttpTransport('', async () => new Response(JSON.stringify({ type: 'error', code, error: 'source lost' })));
    await assert.rejects(
      client.observeTranscript('transcript', () => {}, signal()),
      (error) => error instanceof HttpTransportError && error.kind === 'remote' && error.code === code,
    );
  }
  for (const [body, code] of [
    ['{', 'INVALID_JSON'],
    [JSON.stringify({ type: 'baseline', snapshot: { id: 'transcript' } }), 'INVALID_RESPONSE'],
  ]) {
    const client = new ConversationHttpTransport('', async () => new Response(body));
    await assert.rejects(
      client.observeTranscript('transcript', () => {}, signal()),
      (error) => error instanceof HttpTransportError && error.kind === 'contract' && error.code === code,
    );
  }
  const missing = new ConversationHttpTransport('', async () => new Response(null, { status: 204 }));
  await assert.rejects(
    missing.observeTranscript('transcript', () => {}, signal()),
    (error) => error instanceof HttpTransportError && error.code === 'MISSING_STREAM',
  );
});

test('a transcript consumer TypeError remains a delivery failure and releases the stream', async () => {
  const failure = new TypeError('consumer bug');
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(baseline)}\n`));
    },
    cancel() {
      cancelled = true;
    },
  });
  const client = new ConversationHttpTransport('', async () => new Response(stream));
  await assert.rejects(
    client.observeTranscript(
      'transcript',
      () => {
        throw failure;
      },
      signal(),
    ),
    (error) => error instanceof HttpTransportError && error.kind === 'delivery' && error.cause === failure,
  );
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});

test('an aborted transcript connection never creates a new recoverable error', async () => {
  const controller = new AbortController();
  const failure = new TypeError('request aborted');
  const client = new ConversationHttpTransport('', async () => {
    controller.abort();
    throw failure;
  });
  await assert.rejects(
    client.observeTranscript('transcript', () => {}, controller.signal),
    (error) => error === failure,
  );

  const stopped = new AbortController();
  const stream = new ConversationHttpTransport('', async () => new Response(JSON.stringify(baseline)));
  await stream.observeTranscript('transcript', () => stopped.abort(), stopped.signal);

  const abort = new DOMException('abort', 'AbortError');
  const cancelled = new ConversationHttpTransport('', async () => {
    throw abort;
  });
  await assert.rejects(
    cancelled.observeTranscript('transcript', () => {}, signal()),
    (error) => error === abort,
  );
});

test('transcript recovery classification does not change query or submission failure contracts', async () => {
  const failure = new TypeError('network');
  const client = new ConversationHttpTransport('', async () => {
    throw failure;
  });
  await assert.rejects(client.transcript('transcript'), (error) => error === failure);
  await assert.rejects(
    client.submit({ conversationId: 'fixture-conversation', submissionId: 'submission', input: { messages: [{ role: 'user', content: 'question' }] } }, () => {}, signal()),
    (error) => error === failure,
  );
});
