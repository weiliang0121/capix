import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchRounds } from '../../apps/observer/.test-dist/binding/search.js';

const rounds = [
  { id: 'one', inputContent: '周末去吃饭', response: { content: `${'开头无关内容。'.repeat(100)}注意花生过敏，选择无坚果餐厅。` } },
  { id: 'two', inputContent: '办公键盘有什么推荐？', response: { content: '办公键盘可以考虑无线款。' } },
];

test('search includes full assistant content beyond collapsed previews and identifies its role', () => {
  const matches = searchRounds(rounds, '花生过敏');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].executionId, 'one');
  assert.equal(matches[0].role, 'assistant');
  assert.ok(matches[0].snippet.includes('花生过敏'));
  assert.ok(matches[0].snippet.startsWith('…'));
  assert.ok(matches[0].snippet.length < 100);
});

test('search returns each QA once, preferring input when both sides match', () => {
  assert.deepEqual(
    searchRounds(rounds, '办公').map(({ executionId, role }) => ({ executionId, role })),
    [{ executionId: 'two', role: 'user' }],
  );
  assert.deepEqual(searchRounds(rounds, '  '), []);
  assert.deepEqual(searchRounds(rounds, '没有这样的内容'), []);
});

test('search keeps registration order for many results and handles missing responses', () => {
  const many = Array.from({ length: 120 }, (_, index) => ({ id: String(index), inputContent: 'Review API' }));
  const matches = searchRounds(many, ' api ');
  assert.equal(matches.length, 120);
  assert.equal(matches[119].executionId, '119');
  assert.equal(matches[0].role, 'user');
});
