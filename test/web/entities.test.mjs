import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservationProjection } from '../../apps/observer/.test-dist/binding/observation.js';
import { projectConversation } from '../../apps/observer/.test-dist/observation/conversation.js';
import { transcriptSnapshot } from '../client/fixtures.mjs';

const messages = [
  { role: 'user', content: '原文问题' },
  { role: 'assistant', content: '原文回答' },
];
const overview = {
  transcriptId: 't',
  messages: [
    { index: 0, count: 2 },
    { index: 1, count: 0 },
  ],
  executions: [{ id: 'e', startedAt: '2026-10-09T00:00:00Z', status: 'succeeded', inputIndex: 0, response: { index: 1 }, selections: [{ operationId: 'o', status: 'succeeded', indexes: [0] }], availableMemoryIds: [], memoryChanges: [], calls: [], observedOffsetMs: 0 }],
};
const state = { enabled: true, loading: false, overview, records: new Map(), updates: new Map(), memory: { items: [{ id: 'm', topic: '主题', content: '记忆正文', sources: [{ transcriptId: 't', index: 0 }], records: [] }] } };

test('binding distinguishes unloaded entity references and recomposes observation when only entity data arrives', () => {
  const project = createObservationProjection();
  const first = project(state, new Map());
  assert.equal(first.rounds[0].inputContent, '消息尚未加载');
  assert.equal(first.rounds[0].response.content, undefined);
  assert.equal(first.rounds[0].context.selectedMessages[0].entry, undefined);
  assert.equal(first.memory.items[0].sources[0].state, 'unloaded');
  const second = project(state, new Map([['t', { snapshot: transcriptSnapshot(messages, 't'), syncing: true, loading: false }]]));
  assert.equal(second.rounds[0].inputContent, '原文问题');
  assert.equal(second.rounds[0].response.content, '原文回答');
  assert.equal(second.rounds[0].context.selectedMessages[0].entry.count, 2);
  assert.equal(second.memory.items[0].sources[0].message.content, '原文问题');
  assert.equal(second.memory.items[0].sources[0].state, 'loaded');
  assert.equal('message' in overview.messages[0], false, 'binding does not mutate the observation replica');
});

test('missing and failed entity reads are distinct from unloaded content and unrelated identities never create chat links', () => {
  const project = createObservationProjection();
  const missing = project(state, new Map([['t', { snapshot: transcriptSnapshot([], 't'), loading: false, syncing: false }]]));
  assert.equal(missing.memory.items[0].sources[0].state, 'missing');
  const failure = project(state, new Map([['t', { loading: false, syncing: false, error: new Error('读取失败') }]]));
  assert.equal(failure.memory.items[0].sources[0].state, 'error');
  assert.equal(failure.memory.items[0].sources[0].error, '读取失败');
  assert.equal(projectConversation(messages, overview, 'unrelated')[0].executionId, undefined);
  assert.equal(projectConversation(messages, overview, 't')[0].executionId, 'e');
});
