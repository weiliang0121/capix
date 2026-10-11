import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memoryOutputContract } from '@capix/observer-service';

const source = (id, answerIndex = 1) => ({ id, kind: 'file-created', answerIndex, receipt: { path: `${id}.md`, bytes: 3, digest: 'a'.repeat(64) } });
const input = {
  currentIndexes: [2, 3],
  messages: [0, 2, 3].map((index) => ({ index, message: { role: index % 2 ? 'assistant' : 'user', content: '原文' } })),
  memories: [
    { id: 'old', topic: '保存结果', content: '已创建 old.md', sourceIndexes: [0], sourceResults: [source('old')] },
    { id: 'other', topic: '其他', content: '其他保存结果', sourceIndexes: [0], sourceResults: [source('other')] },
  ],
  results: [source('current', 3)],
};
const candidate = { action: 'create', memoryId: null, change: '创建结果文件', sourceIndexes: [2], sourceResultIds: ['current'], result: { topic: '文件处理', content: '正文保存到 current.md', sourceIndexes: [2, 3], sourceResultIds: ['current'] } };
const accept = (proposal, basis = input) => memoryOutputContract.accept({ memories: [proposal] }, basis);

test('operation source IDs resolve to copied system receipts rather than model-supplied facts', () => {
  const change = accept(candidate).memories[0];
  assert.deepEqual(change.sourceResults, input.results);
  assert.deepEqual(change.result.sourceResults, input.results);
  assert.notEqual(change.sourceResults[0], input.results[0]);
  assert.notEqual(change.sourceResults[0].receipt, input.results[0].receipt);
  assert.equal('sourceResultIds' in change, false);
  assert.equal('sourceResultIds' in change.result, false);
  assert.throws(() => {
    change.result.sourceResults[0].receipt.path = 'forged.md';
  }, TypeError);
  assert.throws(() => {
    change.sourceResults.push(source('forged'));
  }, TypeError);
});

test('memory proposals cannot forge receipts, borrow another memory source or relabel an inherited result as current', () => {
  for (const [proposal, code] of [
    [{ ...candidate, sourceResultIds: ['unknown'] }, 'MEMORY_SOURCE'],
    [{ ...candidate, sourceResultIds: ['old'], result: { ...candidate.result, sourceResultIds: ['old'] } }, 'MEMORY_SOURCE'],
    [{ ...candidate, result: { ...candidate.result, sourceResultIds: [] } }, 'MEMORY_SOURCE'],
    [{ ...candidate, sourceResultIds: [], result: { ...candidate.result, sourceResultIds: ['old'] } }, 'MEMORY_SOURCE'],
    [{ ...candidate, action: 'update', memoryId: 'old', sourceResultIds: [], result: { ...candidate.result, sourceResultIds: ['other'] } }, 'MEMORY_SOURCE'],
    [{ ...candidate, sourceResults: [source('current')] }, 'OUTPUT_SHAPE'],
    [{ ...candidate, result: { ...candidate.result, sourceResults: [source('current')] } }, 'OUTPUT_SHAPE'],
    [{ ...candidate, sourceResultIds: ['current', 'current'] }, 'OUTPUT_SHAPE'],
    [{ ...candidate, result: { ...candidate.result, sourceResultIds: ['current', 'current'] } }, 'OUTPUT_SHAPE'],
    [{ ...candidate, sourceIndexes: [] }, 'OUTPUT_SHAPE'],
    [{ ...candidate, sourceIndexes: [0], result: { ...candidate.result, sourceIndexes: [0] } }, 'MEMORY_SOURCE'],
  ])
    assert.throws(
      () => accept(proposal),
      (error) => error.code === code,
    );
});

test('updates can retain only their own source receipts and unchanged detection includes operation sources', () => {
  const unchanged = { action: 'update', memoryId: 'old', change: '保留原理解', sourceIndexes: [0], result: { topic: '保存结果', content: '已创建 old.md', sourceIndexes: [0], sourceResultIds: ['old'] } };
  assert.deepEqual(accept(unchanged), { memories: [] });
  const updated = { ...unchanged, sourceIndexes: [2], sourceResultIds: ['current'], result: { ...unchanged.result, content: '已创建 old.md 和 current.md', sourceIndexes: [0, 2], sourceResultIds: ['old', 'current'] } };
  const accepted = accept(updated).memories[0];
  assert.deepEqual(accepted.sourceResults, [source('current', 3)]);
  assert.deepEqual(accepted.result.sourceResults, [source('old'), source('current', 3)]);
  const remove = { ...unchanged, sourceIndexes: [2], result: { ...unchanged.result, sourceIndexes: [0, 2], sourceResultIds: [] } };
  const previous = { ...input.memories[0], sourceIndexes: [0, 2] };
  const changed = accept(remove, { ...input, memories: [previous] }).memories;
  assert.equal(changed.length, 1, 'removing operation evidence is a real content change');
  assert.equal('sourceResults' in changed[0].result, false);
});

test('optional unused result references do not add empty fields to ordinary memory content', () => {
  const proposal = { ...candidate, sourceResultIds: [], result: { ...candidate.result, sourceResultIds: [] } };
  const change = accept(proposal).memories[0];
  assert.equal('sourceResults' in change, false);
  assert.equal('sourceResults' in change.result, false);
  assert.equal('sourceResultIds' in change.result, false);
});
