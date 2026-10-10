import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryOutputContract } from '@capix/observer-service';
import { RuntimeErrorHelper } from '@capix/server-runtime';

const input = { currentIndexes: [0, 1], messages: [0, 1].map((index) => ({ index, message: { role: 'user', content: '原文' } })), memories: [] };
const candidate = { action: 'create', memoryId: null, change: '  建立理解  ', sourceIndexes: [0], result: { topic: '  预算  ', content: '  预算300  ', sourceIndexes: [0, 1] } };
const accept = (item) => memoryOutputContract.accept({ memories: [item] }, input);

test('memory structural errors identify nested paths without rewriting or coercing data', () => {
  const cases = [
    [{ ...candidate, action: 'remove' }, 'action'],
    [{ ...candidate, memoryId: 'unexpected' }, 'memoryId'],
    [{ ...candidate, action: 'update', memoryId: null }, 'memoryId'],
    [{ ...candidate, action: 'update', memoryId: '' }, 'memoryId'],
    [{ ...candidate, change: ' \n\t ' }, 'change'],
    [{ ...candidate, change: 'x'.repeat(1001) }, 'change'],
    [{ ...candidate, result: { ...candidate.result, topic: 'x'.repeat(121) } }, 'result.topic'],
    [{ ...candidate, result: { ...candidate.result, content: 'x'.repeat(2001) } }, 'result.content'],
    [{ ...candidate, result: { ...candidate.result, content: null } }, 'result.content'],
    [{ ...candidate, result: { ...candidate.result, content: '  ' } }, 'result.content'],
    [{ ...candidate, sourceIndexes: [] }, 'sourceIndexes'],
    [{ ...candidate, sourceIndexes: [0, 0] }, 'sourceIndexes'],
    [{ ...candidate, sourceIndexes: ['0'] }, 'sourceIndexes.0'],
    [{ ...candidate, sourceIndexes: [-1] }, 'sourceIndexes.0'],
    [{ ...candidate, sourceIndexes: [0.5] }, 'sourceIndexes.0'],
    [{ ...candidate, sourceIndexes: [Number.MAX_SAFE_INTEGER + 1] }, 'sourceIndexes.0'],
    [{ ...candidate, result: { ...candidate.result, sourceIndexes: [0, 0] } }, 'result.sourceIndexes'],
  ];
  for (const [value, path] of cases) {
    assert.throws(
      () => accept(value),
      (error) => {
        assert.equal(error.code, 'OUTPUT_SHAPE');
        assert.ok(
          error.detail.issues.some((issue) => issue.path.join('.') === `memories.0.${path}`),
          path,
        );
        const recorded = JSON.parse(JSON.stringify(RuntimeErrorHelper.format(error)));
        assert.deepEqual(recorded.detail.issues, error.detail.issues);
        return true;
      },
    );
  }
  const accepted = accept(candidate).memories[0];
  assert.deepEqual(accepted, candidate);
  assert.notEqual(accepted, candidate);
  assert.notEqual(accepted.result, candidate.result);
  assert.notEqual(accepted.sourceIndexes, candidate.sourceIndexes);
  assert.notEqual(accepted.result.sourceIndexes, candidate.result.sourceIndexes);
});

test('memory structure is strict at every level and keeps the four-change bound', () => {
  for (const value of [{ memories: [], extra: true }, { memories: [{ ...candidate, extra: true }] }, { memories: [{ ...candidate, result: { ...candidate.result, extra: true } }] }, { memories: Array(5).fill(candidate) }, { memories: null }, {}])
    assert.throws(
      () => memoryOutputContract.accept(value, input),
      (error) => error.code === 'OUTPUT_SHAPE',
    );
  assert.equal(memoryOutputContract.accept({ memories: Array(4).fill(candidate) }, input).memories.length, 4);
  assert.deepEqual(memoryOutputContract.accept({ memories: [] }, input), { memories: [] });
});

test('generated memory schema retains action-specific IDs, unique sources and limits for the model', () => {
  const schema = memoryOutputContract.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['memories']);
  const memories = schema.properties.memories;
  assert.equal(memories.maxItems, 4);
  const [create, update] = memories.items.oneOf;
  assert.equal(create.properties.action.const, 'create');
  assert.equal(create.properties.memoryId.type, 'null');
  assert.equal(update.properties.action.const, 'update');
  assert.equal(update.properties.memoryId.type, 'string');
  assert.equal(update.properties.memoryId.minLength, 1);
  for (const branch of [create, update]) {
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(branch.required, ['action', 'memoryId', 'change', 'sourceIndexes', 'result']);
    assert.equal(branch.properties.change.maxLength, 1000);
    assert.equal(new RegExp(branch.properties.change.pattern).test(' \n '), false);
    const result = branch.properties.result;
    assert.equal(result.additionalProperties, false);
    assert.deepEqual(result.required, ['topic', 'content', 'sourceIndexes']);
    assert.equal(result.properties.topic.maxLength, 120);
    assert.equal(result.properties.content.maxLength, 2000);
    for (const text of [result.properties.topic, result.properties.content]) {
      assert.equal(new RegExp(text.pattern).test(' \t '), false);
      assert.equal(new RegExp(text.pattern).test(' 正文 '), true);
    }
    for (const indexes of [branch.properties.sourceIndexes, result.properties.sourceIndexes]) {
      assert.equal(indexes.minItems, 1);
      assert.equal(indexes.uniqueItems, true);
      assert.equal(indexes.items.type, 'integer');
      assert.equal(indexes.items.minimum, 0);
      assert.equal(indexes.items.maximum, Number.MAX_SAFE_INTEGER);
    }
  }
});
