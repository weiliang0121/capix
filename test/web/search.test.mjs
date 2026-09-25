import assert from 'node:assert/strict';
import { test } from 'node:test';
import { searchExecutions } from '../../apps/observer/.test-dist/features/explorer/search.js';

const overview = {
  messages: [
    { index: 0, message: { role: 'user', content: '周末去吃饭' } },
    { index: 2, message: { role: 'user', content: '办公键盘有什么推荐？' } },
  ],
  executions: [
    { id: 'one', inputIndex: 0, response: { content: `${'开头无关内容。'.repeat(100)}注意花生过敏，选择无坚果餐厅。` } },
    { id: 'two', inputIndex: 2, response: { content: '办公键盘可以考虑无线款。' } },
  ],
};

test('search includes full assistant content beyond collapsed previews and identifies its role', () => {
  const matches = searchExecutions(overview, '花生过敏');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].executionId, 'one');
  assert.equal(matches[0].role, 'assistant');
  assert.ok(matches[0].snippet.includes('花生过敏'));
  assert.ok(matches[0].snippet.startsWith('…'));
  assert.ok(matches[0].snippet.length < 100);
});

test('search returns each QA once, preferring input when both sides match', () => {
  assert.deepEqual(
    searchExecutions(overview, '办公').map(({ executionId, role }) => ({ executionId, role })),
    [{ executionId: 'two', role: 'user' }],
  );
  assert.deepEqual(searchExecutions(overview, '  '), []);
  assert.deepEqual(searchExecutions(overview, '没有这样的内容'), []);
});

test('search keeps registration order for many results and handles missing responses', () => {
  const many = { messages: [{ index: 0, message: { role: 'user', content: 'Review API' } }], executions: Array.from({ length: 120 }, (_, index) => ({ id: String(index), inputIndex: 0 })) };
  const matches = searchExecutions(many, ' api ');
  assert.equal(matches.length, 120);
  assert.equal(matches[119].executionId, '119');
  assert.equal(matches[0].role, 'user');
});
