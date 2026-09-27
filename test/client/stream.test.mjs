import test from 'node:test';
import assert from 'node:assert/strict';
import { ObserverHttpTransport } from '@capix-observer/client-http';
import { snapshot } from './fixtures.mjs';

const consumeRunStream = (body, accept) => new ObserverHttpTransport('', async () => new Response(body)).run({ messages: [] }, accept, () => {});

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
const line = (value) => JSON.stringify({ type: 'snapshot', snapshot: value });

test('run stream joins UTF-8 byte and line boundaries and accepts a final line without newline', async () => {
  const received = [];
  await consumeRunStream(stream(`${line(snapshot('running'))}\n${line(snapshot())}`, 1), (value) => received.push(value));
  assert.deepEqual(
    received.map((value) => value.execution.status),
    ['running', 'succeeded'],
  );
  assert.equal(received[1].execution.value.output.content, '这是中文回答');
});
test('run stream refuses premature EOF instead of presenting a running call as complete', async () => {
  await assert.rejects(
    consumeRunStream(stream(`${line(snapshot('running'))}\n`), () => {}),
    /提前结束/,
  );
  await assert.rejects(
    consumeRunStream(stream(''), () => {}),
    /提前结束/,
  );
});
test('run stream preserves a recorded work failure and surfaces transport failure separately', async () => {
  const received = [];
  await consumeRunStream(stream(line(snapshot('failed'))), (value) => received.push(value));
  assert.equal(received[0].execution.value.error.code, 'TEST');
  await assert.rejects(
    consumeRunStream(stream(`${line(snapshot('running'))}\n${JSON.stringify({ type: 'error', error: '记录发布失败', code: 'INTERNAL_ERROR' })}\n`), () => {}),
    /记录发布失败/,
  );
});
test('run stream rejects malformed records and execution identity changes', async () => {
  await assert.rejects(
    consumeRunStream(stream('{"type":"snapshot","snapshot":{}}\n'), () => {}),
    /格式无效/,
  );
  await assert.rejects(
    consumeRunStream(stream(`${line(snapshot('running'))}\n${line(snapshot('succeeded', 'another'))}\n`), () => {}),
    /不同执行/,
  );
});
