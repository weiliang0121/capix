import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { isNonBlankString } from '../../dist/server/value/string.js';
import { isNonEmptyArray, hasUniqueItems } from '../../dist/server/value/array.js';
import { modelTextSchema, modelIndexesSchema } from '../../dist/server/operations/model/schema.js';
import { Transcript } from '../../dist/server/transcript/transcript.js';
import { Memory } from '../../dist/server/memory/memory.js';

test('text predicates, model schema and message acceptance agree without normalizing text', () => {
  const cases = [
    [null, false],
    [undefined, false],
    [1, false],
    [new String('text'), false],
    ['', false],
    [' \t\r\n\u00a0\u3000\ufeff', false],
    ['  原文\n', true],
    ['\u200b', true],
  ];
  const pattern = new RegExp(z.toJSONSchema(modelTextSchema).pattern);
  for (const [value, valid] of cases) {
    assert.equal(isNonBlankString(value), valid);
    assert.equal(modelTextSchema.safeParse(value).success, valid);
    if (typeof value === 'string') assert.equal(pattern.test(value), valid);
    if (valid) assert.equal(new Transcript([{ role: 'user', content: value }]).get(0).content, value);
    else assert.throws(() => new Transcript([{ role: 'user', content: value }]), TypeError);
  }
});

test('array presence and uniqueness are separate rules; validation preserves order and duplicates', () => {
  for (const value of [null, undefined, '', 'text', { length: 1 }, []]) assert.equal(isNonEmptyArray(value), false);
  const values = Object.freeze([3, 1, 3]);
  assert.equal(isNonEmptyArray(values), true);
  assert.equal(hasUniqueItems(values), false);
  assert.deepEqual(values, [3, 1, 3]);
  assert.equal(hasUniqueItems([]), true);
  const object = {};
  assert.equal(hasUniqueItems([object, object]), false);
  assert.equal(hasUniqueItems([{}, {}]), true);
  assert.equal(modelIndexesSchema().safeParse([]).success, true);
  assert.equal(modelIndexesSchema(1).safeParse([]).success, false);
  assert.equal(modelIndexesSchema().safeParse(values).success, false);
  assert.deepEqual(modelIndexesSchema().parse([3, 1]), [3, 1]);
});

test('memory validation leaves source existence to Transcript and preserves content on rejection', () => {
  const transcript = new Transcript([{ role: 'user', content: '依据' }]);
  const content = { topic: '  主题 ', content: ' 内容\n', sourceIndexes: [0] };
  const memory = new Memory(transcript, content);
  const snapshot = memory.snapshot();
  assert.equal(memory.topic, content.topic);
  assert.equal(memory.content, content.content);
  for (const invalid of [{ topic: ' \u3000' }, { content: new String('text') }, { sourceIndexes: [] }, { sourceIndexes: [0, 0] }, { sourceIndexes: { length: 1 } }]) {
    assert.throws(() => memory.update({ ...content, ...invalid }), TypeError);
    assert.equal(memory.snapshot(), snapshot);
  }
  assert.throws(() => memory.update({ ...content, sourceIndexes: [99] }), RangeError);
  assert.equal(memory.snapshot(), snapshot);
});
