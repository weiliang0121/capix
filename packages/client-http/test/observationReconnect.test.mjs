import test from 'node:test';

import assert from 'node:assert/strict';

import { ObservationHttpTransport, HttpError, HttpTransportError } from '@capix/client-http';

import { ObservationConnectionError } from '@capix/client-runtime';

import { baseline } from './fixtures.mjs';

const observe = (fetcher, accept = () => {}) => new ObservationHttpTransport('', fetcher).observe('fixture-conversation', accept, new AbortController().signal);

test('observation HTTP marks only network loss, EOF and temporary unstructured statuses as reconnectable', async () => {
  await assert.rejects(
    observe(async () => {
      throw new TypeError('fetch failed');
    }),
    ObservationConnectionError,
  );
  await assert.rejects(
    observe(async () => new Response(JSON.stringify(baseline()))),
    ObservationConnectionError,
  );
  await assert.rejects(
    observe(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('connection reset'));
            },
          }),
        ),
    ),
    ObservationConnectionError,
  );
  for (const status of [408, 429, 500, 502, 503, 504]) {
    await assert.rejects(
      observe(async () => new Response('upstream unavailable', { status })),
      (error) => error instanceof ObservationConnectionError && error.cause instanceof HttpError && error.cause.response.status === status,
    );
  }
  for (const status of [400, 401, 403, 404, 409])
    await assert.rejects(
      observe(async () => new Response('', { status })),
      HttpError,
    );
});

test('source failure, malformed protocol and consumer exceptions cannot masquerade as network loss', async () => {
  for (const fetcher of [async () => Response.json({ error: 'source incomplete', code: 'SOURCE_INCOMPLETE' }, { status: 503 }), async () => new Response(JSON.stringify({ type: 'error', error: 'source incomplete', code: 'SOURCE_INCOMPLETE' }))]) {
    await assert.rejects(observe(fetcher), (error) => !(error instanceof ObservationConnectionError) && error.code === 'SOURCE_INCOMPLETE');
  }
  await assert.rejects(
    observe(async () => new Response('not json')),
    (error) => error instanceof HttpTransportError && error.kind === 'contract',
  );
  await assert.rejects(
    observe(
      async () => new Response(JSON.stringify(baseline())),
      () => {
        throw new TypeError('view failure');
      },
    ),
    (error) => error instanceof HttpTransportError && error.kind === 'delivery',
  );
});
