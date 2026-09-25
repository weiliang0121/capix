import test from 'node:test';
import assert from 'node:assert/strict';
import { projectConversation } from '../../apps/observer/.test-dist/observation/conversation.js';

const user = { role: 'user', content: '问题' };
const assistant = { role: 'assistant', content: '回答' };
const execution = { id: 'execution-1', inputIndex: 0, response: { content: assistant.content } };
const overview = { messages: [], executions: [execution] };

test('observed answer survives failed refresh and remains before a later input', () => {
  const messages = [user, { role: 'user', content: '后续问题' }];
  const rows = projectConversation(messages, overview);
  assert.deepEqual(
    rows.map((row) => row.message.content),
    ['问题', '回答', '后续问题'],
  );
  assert.equal(rows[1].executionId, 'execution-1');
  assert.equal(rows[1].index, undefined);
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

test('overview answer remains visible when its known message index is not loaded', () => {
  const rows = projectConversation([user], { ...overview, executions: [{ ...execution, response: { ...execution.response, index: 1 } }] });
  assert.equal(rows.length, 2);
  assert.equal(rows[1].index, 1);
});
