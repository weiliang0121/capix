import test from 'node:test';
import assert from 'node:assert/strict';
import { projectConversation } from '../../apps/observer/.test-dist/observation/conversation.js';

const user = { role: 'user', content: '问题' };
const assistant = { role: 'assistant', content: '回答' };
const execution = { id: 'execution-1', inputIndex: 0, response: { content: assistant.content } };
const overview = { messages: [], executions: [execution] };

test('observation may add links but never creates a conversation answer', () => {
  const messages = [user, { role: 'user', content: '后续问题' }];
  const rows = projectConversation(messages, overview);
  assert.deepEqual(
    rows.map((row) => row.message.content),
    ['问题', '后续问题'],
  );
  assert.equal(rows[0].executionId, 'execution-1');
  assert.equal(messages.length, 2);
});

test('formal message index reconciles observed answer without duplicate or text matching', () => {
  const messages = [user, assistant, { role: 'user', content: '问题' }, assistant];
  const reconciled = {
    messages: [],
    executions: [
      { ...execution, response: { ...execution.response, index: 1 } },
      { ...execution, id: 'execution-2', inputIndex: 2, response: { ...execution.response, index: 3 } },
    ],
  };
  const rows = projectConversation(messages, reconciled);
  assert.equal(rows.length, 4);
  assert.equal(rows[1].executionId, 'execution-1');
  assert.equal(rows[3].executionId, 'execution-2');
  assert.equal(rows[3].round, 2);
});

test('unloaded answers are not fabricated from observation records', () => {
  const rows = projectConversation([user], { ...overview, executions: [{ ...execution, response: { ...execution.response, index: 1 } }] });
  assert.equal(rows.length, 1);
});

test('conversation content is complete without observation data', () => {
  const rows = projectConversation([user, assistant], { messages: [], executions: [] });
  assert.deepEqual(
    rows.map((row) => row.message),
    [user, assistant],
  );
  assert.ok(rows.every((row) => row.executionId === undefined));
});
