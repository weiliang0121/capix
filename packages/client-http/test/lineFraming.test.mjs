import test from 'node:test';

import assert from 'node:assert/strict';

import { ConversationHttpTransport, HttpTransportError } from '@capix/client-http';

import { TranscriptConnectionError } from '@capix/client-runtime';

import { transcriptSnapshot } from './fixtures.mjs';

import { readLines } from '../dist/stream.js';

test('fragmented long lines scan only newly decoded characters and preserve UTF-8 and final lines', async (t) => {
  const baseline = { type: 'baseline', snapshot: transcriptSnapshot([{ role: 'user', content: '消息🙂'.repeat(8000) }], 'transcript') };
  const delta = { type: 'delta', event: { type: 'transcript', transcriptId: 'transcript', revision: 2, occurredAt: '2026-10-13T00:00:00Z', change: { kind: 'messages-appended', start: 1, messages: [{ role: 'assistant', content: '完成' }] } } };
  const text = ` \n${JSON.stringify(baseline)}\n\n${JSON.stringify(delta)}`;
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) return controller.close();
      const end = Math.min(offset + 13, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  });
  let searched = 0;
  const indexOf = String.prototype.indexOf;
  t.mock.method(String.prototype, 'indexOf', function (value, start = 0) {
    if (value === '\n') searched += this.length - start;
    return indexOf.call(this, value, start);
  });
  const received = [];
  const client = new ConversationHttpTransport('', async () => new Response(stream));
  await assert.rejects(
    client.observeTranscript('transcript', (frame) => received.push(frame), new AbortController().signal),
    TranscriptConnectionError,
  );
  assert.deepEqual(received, [baseline, delta]);
  assert.ok(searched < text.length * 2, `newline searches revisited ${searched} characters for ${text.length} decoded characters`);
  assert.equal(stream.locked, false);
});

function chunks(values, close = true) {
  let offset = 0;
  let cancelled = false;
  const stream = new ReadableStream({
    pull(controller) {
      if (offset < values.length) controller.enqueue(values[offset++]);
      else if (close) controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    stream,
    get cancelled() {
      return cancelled;
    },
  };
}

async function collect(stream, limit) {
  const lines = [];
  for await (const line of readLines(stream, limit)) lines.push(line);
  return lines;
}

test('line budgets count UTF-8 across split characters, reset on every line and apply to unterminated final lines', async () => {
  const bytes = new TextEncoder().encode('文🙂\n文🙂\n文🙂');
  const source = chunks(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  assert.deepEqual(await collect(source.stream, 7), ['文🙂', '文🙂', '文🙂']);
  assert.equal(source.stream.locked, false);
  assert.equal(source.cancelled, false);
  for (const text of ['文🙂\n', '文🙂', 'ok\n文🙂']) {
    const bytes = new TextEncoder().encode(text);
    const failed = chunks(
      Array.from(bytes, (byte) => Uint8Array.of(byte)),
      false,
    );
    await assert.rejects(collect(failed.stream, 6), (error) => error instanceof HttpTransportError && error.kind === 'contract' && error.code === 'FRAME_TOO_LARGE');
    assert.equal(failed.cancelled, true);
    assert.equal(failed.stream.locked, false);
  }
});

test('HTTP consumers reject the default 16 MiB line budget and cancel the stream before JSON acceptance', async () => {
  const oversized = new Uint8Array(16 * 1024 * 1024 + 1).fill(32);
  const source = chunks([oversized], false);
  const client = new ConversationHttpTransport('', async () => new Response(source.stream));
  await assert.rejects(
    client.observeTranscript('transcript', () => assert.fail('oversized line must not be delivered'), new AbortController().signal),
    (error) => error instanceof HttpTransportError && error.kind === 'contract' && error.code === 'FRAME_TOO_LARGE',
  );
  assert.equal(source.cancelled, true);
  assert.equal(source.stream.locked, false);
});

test('line reading releases readers after early consumer exit and source errors', async () => {
  const source = chunks([new TextEncoder().encode('one\ntwo\n')], false);
  const lines = readLines(source.stream, 3);
  assert.deepEqual(await lines.next(), { done: false, value: 'one' });
  await lines.return();
  assert.equal(source.cancelled, true);
  assert.equal(source.stream.locked, false);
  const failure = new Error('source read failed');
  const failed = new ReadableStream({
    pull(controller) {
      controller.error(failure);
    },
  });
  await assert.rejects(collect(failed, 3), (error) => error === failure);
  assert.equal(failed.locked, false);
});

test('line budgets reject non-positive or unsafe values before acquiring the reader', async () => {
  for (const limit of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const source = chunks([], false);
    await assert.rejects(collect(source.stream, limit), TypeError);
    assert.equal(source.stream.locked, false);
    assert.equal(source.cancelled, false);
  }
});
