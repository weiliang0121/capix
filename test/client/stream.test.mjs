import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix/client-http';
import { snapshot, baseline, entriesOf, submissionSnapshot } from './fixtures.mjs';

function stream(text, chunkSize = 7) {
  const bytes = new TextEncoder().encode(text);
  let cursor = 0;
  return new ReadableStream({
    pull(controller) {
      if (cursor >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(cursor, (cursor += chunkSize)));
    },
  });
}
const input = { transcriptId: 't', start: 0, end: 1 };
const first = submissionSnapshot('s', { revision: 1, input, executions: [{ contextId: 'e' }] });
const answer = { ...first, revision: 3, answer: { transcriptId: 't', index: 3 } };
const completed = { ...answer, revision: 4, result: { status: 'completed' } };
const wire = (item) => (item.submissionId ? { type: 'baseline', submission: item } : item);
const lines = (...items) => items.map((item) => JSON.stringify(wire(item))).join('\n');
const consume = (text, accept = () => {}) => new ConversationHttpTransport('', async () => new Response(stream(text, 1))).submit({ conversationId: 'fixture-conversation', submissionId: 's', input: { messages: [] } }, accept, new AbortController().signal);

test('cumulative feedback joins UTF-8 and line boundaries independently of record and entity streams', async () => {
  const failed = { ...answer, revision: 4, result: { status: 'failed', error: { code: 'POSTPROCESS', message: '记忆处理失败' } } };
  const received = [];
  await consume(lines(first, answer, failed), (update) => received.push(update));
  assert.deepEqual(received, [first, answer, failed].map(wire));
});
test('feedback requires a terminal fact and keeps delivered facts on premature EOF', async () => {
  const received = [];
  await assert.rejects(
    consume(lines(first, answer), (update) => received.push(update)),
    /提前结束/,
  );
  assert.deepEqual(received, [first, answer].map(wire));
  await assert.rejects(consume(''), /提前结束/);
});
test('feedback accepts revision jumps and nonadjacent answer locators', async () => {
  const received = [];
  await consume(lines(first, answer, completed), (update) => received.push(update));
  assert.deepEqual(received, [first, answer, completed].map(wire));
});
test('feedback rejects mismatched identity and invalid numeric fields', async () => {
  for (const value of [
    { ...first, submissionId: 'other' },
    { ...first, revision: 1.5 },
    { ...first, answer: { transcriptId: 't', index: Number.MAX_SAFE_INTEGER + 1 } },
  ]) {
    await assert.rejects(consume(lines(value)), (error) => error.kind === 'contract');
  }
});
test('observation stream accepts multiple executions independently and validates records', async () => {
  const received = [];
  const http = new ObservationHttpTransport('', async () => new Response(stream(lines(baseline({ entries: entriesOf(snapshot()) }), { type: 'delta', scopeId: 'fixture-scope', sequence: 1, changes: entriesOf(snapshot('running', 'another')).map((entry, index) => ({ type: 'record', recorderId: 'fixture-recorder', revision: index + 1, occurredAt: '2026-09-30T00:00:00Z', change: { kind: 'added', entry } })) }))));
  await assert.rejects(
    http.observe('fixture-conversation', (value) => received.push(value), new AbortController().signal),
    /观测连接已结束/,
  );
  assert.deepEqual(
    received.map((value) => (value.type === 'baseline' ? value.entries.find((entry) => entry.kind === 'invocation' && entry.data.role === 'conversation-task').data.id : value.changes.find((event) => event.change.entry.kind === 'invocation' && event.change.entry.data.role === 'conversation-task').change.entry.data.id)),
    ['execution-1', 'another'],
  );
  const invalid = new ObservationHttpTransport('', async () => new Response('{"type":"snapshot","snapshot":{}}\n'));
  await assert.rejects(
    invalid.observe('fixture-conversation', () => {}, new AbortController().signal),
    (error) => error.code === 'INVALID_RESPONSE',
  );
});
