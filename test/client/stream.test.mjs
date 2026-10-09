import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix-observer/client-http';
import { snapshot, baseline, entriesOf } from './fixtures.mjs';

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
const started = { type: 'started', contextId: 'context', transcriptId: 'fixture-transcript', inputIndex: 0 };
const answer = { type: 'answer', contextId: 'context', transcriptId: 'fixture-transcript', index: 1, output: { kind: 'answer', content: '这是中文回答' } };
const completed = { type: 'completed', contextId: 'context' };
const lines = (...items) => items.map((item) => JSON.stringify(item)).join('\n');
const consume = (text, accept = () => {}) => new ConversationHttpTransport('', async () => new Response(stream(text, 1))).run({ messages: [] }, accept, () => {});

test('business stream joins UTF-8 and line boundaries without fetching any records', async () => {
  const received = [];
  await consume(lines(started, answer, completed), (update) => received.push(update));
  assert.deepEqual(received, [started, answer, completed]);
});
test('business stream requires explicit completion and keeps a delivered answer on premature EOF', async () => {
  const received = [];
  await assert.rejects(
    consume(lines(started, answer), (update) => received.push(update)),
    /提前结束/,
  );
  assert.deepEqual(received, [started, answer]);
  await assert.rejects(consume(''), /提前结束/);
});
test('business stream distinguishes errors from completion, including errors after an answer', async () => {
  const received = [];
  await assert.rejects(
    consume(lines(started, answer, { type: 'error', error: '后处理失败', code: 'POSTPROCESS' }), (update) => received.push(update)),
    (error) => error.kind === 'remote' && error.code === 'POSTPROCESS',
  );
  assert.deepEqual(received, [started, answer]);
});
test('business stream rejects identity changes, duplicate answers, misplaced answers and terminal regression', async () => {
  for (const [items, code] of [
    [[answer], 'CONVERSATION_MISMATCH'],
    [[started, { ...answer, contextId: 'other' }], 'CONVERSATION_MISMATCH'],
    [[started, answer, answer], 'INVALID_UPDATE'],
    [[started, started], 'INVALID_UPDATE'],
    [[started, { ...answer, index: 0 }], 'INVALID_UPDATE'],
    [[started, { ...answer, index: 1.5 }], 'INVALID_RESPONSE'],
    [[started, { ...answer, index: Number.MAX_SAFE_INTEGER + 1 }], 'INVALID_RESPONSE'],
    [[started, completed], 'MISSING_ANSWER'],
    [[started, answer, completed, started], 'AFTER_TERMINAL'],
  ])
    await assert.rejects(consume(lines(...items)), (error) => error.code === code);
  await assert.rejects(consume('{"type":"snapshot","snapshot":{}}'), /格式无效/);
});
test('observation stream accepts multiple executions independently and validates records', async () => {
  const received = [];
  const http = new ObservationHttpTransport('', async () => new Response(stream(lines(baseline({ entries: entriesOf(snapshot()) }), { type: 'delta', scopeId: 'fixture-scope', sequence: 1, changes: entriesOf(snapshot('running', 'another')).map((entry, index) => ({ type: 'record', recorderId: 'fixture-recorder', revision: index + 1, occurredAt: '2026-09-30T00:00:00Z', change: { kind: 'added', entry } })) }))));
  await assert.rejects(
    http.observe((value) => received.push(value), new AbortController().signal),
    /观测连接已结束/,
  );
  assert.deepEqual(
    received.map((value) => (value.type === 'baseline' ? value.entries.find((entry) => entry.kind === 'execution').data.id : value.changes.find((event) => event.change.entry.kind === 'execution').change.entry.data.id)),
    ['execution-1', 'another'],
  );
  const invalid = new ObservationHttpTransport('', async () => new Response('{"type":"snapshot","snapshot":{}}\n'));
  await assert.rejects(
    invalid.observe(() => {}, new AbortController().signal),
    (error) => error.code === 'INVALID_RESPONSE',
  );
});

test('business stream accepts an answer after independently appended messages without assuming adjacency', async () => {
  const later = { ...answer, index: 3 };
  const received = [];
  await consume(lines(started, later, completed), (update) => received.push(update));
  assert.deepEqual(received, [started, later, completed]);
});
