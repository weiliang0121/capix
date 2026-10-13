import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { observationWriter } from '../../services/observer/dist/http/observation-writer.js';

test('source termination drops the unsent backlog and waits for the writable boundary', () => {
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.writableLength = 0;
  const lines = [];
  response.write = (line) => {
    lines.push(JSON.parse(line));
    return false;
  };
  response.end = (line) => {
    lines.push(JSON.parse(line));
    response.writableEnded = true;
  };
  response.destroy = () => {
    response.destroyed = true;
  };
  const write = observationWriter(response);
  write({ type: 'baseline' });
  write({ type: 'delta', sequence: 1 });
  write({ type: 'delta', sequence: 2 });
  write.end({ type: 'error', code: 'SOURCE_INCOMPLETE' });
  assert.deepEqual(lines, [{ type: 'baseline' }]);
  response.emit('drain');
  assert.deepEqual(lines, [{ type: 'baseline' }, { type: 'error', code: 'SOURCE_INCOMPLETE' }]);
  write({ type: 'delta', sequence: 3 });
  response.emit('drain');
  assert.equal(lines.length, 2);
});

test('an invalid source replaces a baseline still waiting behind transport backpressure', () => {
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.writableLength = 100;
  response.writableNeedDrain = true;
  const frames = [];
  response.write = () => assert.fail('queued baseline must not be written');
  response.end = (line) => {
    frames.push(JSON.parse(line));
    response.writableEnded = true;
  };
  const write = observationWriter(response);
  write({ type: 'baseline' });
  write.end({ type: 'error', code: 'SOURCE_INCOMPLETE' });
  assert.deepEqual(frames, []);
  response.emit('drain');
  assert.deepEqual(frames, [{ type: 'error', code: 'SOURCE_INCOMPLETE' }]);
});

test('a slow connection drains every queued delta in order and measures UTF-8 bytes once', (t) => {
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.writableLength = 0;
  response.writableNeedDrain = true;
  const received = [];
  response.write = (line) => {
    received.push(JSON.parse(line));
    return false;
  };
  response.destroy = () => assert.fail('bounded backlog must stay live');
  const measure = t.mock.method(Buffer, 'byteLength');
  const write = observationWriter(response);
  const frames = Array.from({ length: 3000 }, (_, sequence) => ({ type: 'delta', sequence, value: '中文🙂' }));
  for (const frame of frames) write(frame);
  for (let index = 0; index < frames.length; index++) response.emit('drain');
  assert.deepEqual(received, frames);
  assert.equal(measure.mock.callCount(), frames.length);
  response.emit('drain');
  write({ type: 'delta', sequence: frames.length });
  assert.equal(received.at(-1).sequence, frames.length);
});

test('a blocked connection remains bounded by serialized UTF-8 bytes', () => {
  const response = new EventEmitter();
  response.destroyed = false;
  response.writableEnded = false;
  response.writableLength = 0;
  response.writableNeedDrain = true;
  response.write = () => assert.fail('connection is blocked');
  response.destroy = () => {
    response.destroyed = true;
    response.emit('close');
  };
  const write = observationWriter(response);
  const frame = { text: '文'.repeat(3 * 1024 * 1024) };
  write(frame);
  assert.equal(response.destroyed, false);
  write(frame);
  assert.equal(response.destroyed, true);
  response.emit('drain');
});
