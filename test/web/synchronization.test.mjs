import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataProjection } from '../../apps/observer/.test-dist/binding/data.js';
import { projectResponses } from '../../apps/observer/.test-dist/binding/responses.js';
import { client, transport, submissionSnapshot, transcriptSnapshot } from '../client/fixtures.mjs';

const transcriptId = 'sync-presentation';
const content = [
  { role: 'user', content: '问题' },
  { role: 'assistant', content: '已经收到的完整回答' },
];
const snapshot = transcriptSnapshot(content, transcriptId);
const initial = () => ({ ...client({ conversation: transport() }).getSnapshot(), transcriptId, messages: content });
const source = (sync) => new Map([[transcriptId, { snapshot, sync }]]);

test('message recovery keeps existing content readable and exposes a bounded connection action without internal diagnostics', () => {
  const state = initial();
  const project = createDataProjection();
  const first = project({ ...state, transcripts: source({ status: 'live' }) });
  assert.equal(first.conversationSync, undefined);
  for (const sync of [{ status: 'connecting', attempt: 1 }, { status: 'retrying', attempt: 2, retryAt: 2000, error: new Error('INTERNAL_NETWORK_DETAIL') }, { status: 'failed', error: new Error('INTERNAL_PROTOCOL_DETAIL') }, { status: 'stopped' }]) {
    const data = project({ ...state, transcripts: source(sync) });
    assert.deepEqual(
      data.conversation.map((item) => item.message),
      content,
    );
    assert.equal(data.conversationSync.reconnect, sync.status === 'failed' || sync.status === 'stopped');
    assert.doesNotMatch(data.conversationSync.message, /INTERNAL_/);
  }
  const recovered = project({ ...state, transcripts: source({ status: 'live' }) });
  assert.equal(recovered.conversationSync, undefined);
  assert.deepEqual(
    recovered.conversation.map((item) => item.message),
    content,
  );
});

test('initial message synchronization has a progress notice without presenting it as failure', () => {
  const state = { ...initial(), messages: [], transcripts: new Map([[transcriptId, { sync: { status: 'connecting', attempt: 0 } }]]) };
  const data = createDataProjection()(state);
  assert.match(data.conversationSync.message, /正在同步消息/);
  assert.equal(data.conversationSync.reconnect, false);
  assert.equal(data.conversation.length, 0);
});

test('environment initialization explains connection failures before identity discovery and configuration failures after message connection', () => {
  const project = createDataProjection();
  for (const identified of [false, true]) {
    const state = { ...initial(), transcriptId: identified ? transcriptId : undefined, transcripts: identified ? source({ status: 'live' }) : new Map() };
    const connecting = project({ ...state, initialization: { status: 'running', attempt: 1 } });
    assert.match(connecting.conversationSync.message, /正在建立对话连接/);
    assert.equal(connecting.conversationSync.reconnect, false);
    const failed = project({ ...state, initialization: { status: 'failed', attempt: 1, error: new Error('内部初始化原因') } });
    assert.match(failed.conversationSync.message, /对话连接未能建立/);
    assert.equal(failed.conversationSync.reconnect, true);
    assert.doesNotMatch(failed.conversationSync.message, /内部初始化原因/);
    const stopped = project({ ...state, initialization: { status: 'stopped', attempt: 1 } });
    assert.match(stopped.conversationSync.message, /对话连接已停止/);
    assert.equal(stopped.conversationSync.reconnect, true);
    const ready = project({ ...state, initialization: { status: 'succeeded', attempt: 2 } });
    assert.equal(ready.conversationSync, undefined);
  }
});

test('a stale snapshot does not classify missing answer content while a new baseline is being acquired', () => {
  const submission = { id: 'answer', queueId: 'local-answer', pending: '问题', feedback: { status: 'ended' }, remote: submissionSnapshot('answer', { input: { transcriptId, start: 0, end: 1 }, answer: { transcriptId, index: 1 }, result: { status: 'completed' } }) };
  const state = { ...initial(), submission, submissions: new Map([[submission.id, submission]]) };
  const rows = content.map((message, index) => ({ key: `message-${index}`, index, message }));
  for (const sync of [
    { status: 'connecting', attempt: 1 },
    { status: 'retrying', attempt: 1, retryAt: 1000, error: new Error('网络详情') },
  ]) {
    const pending = projectResponses(rows.slice(0, 1), { ...state, transcripts: source(sync) })[1];
    assert.equal(pending.bodyState, 'pending');
    assert.equal(pending.process.active, true);
    assert.equal(pending.notice, undefined);
    const available = projectResponses(rows, { ...state, transcripts: source(sync) })[1];
    assert.equal(available.bodyState, 'available');
    assert.equal(available.body.message, content[1]);
    assert.equal(available.process, undefined);
    assert.equal(available.notice, undefined);
  }
  const failed = projectResponses(rows.slice(0, 1), { ...state, transcripts: source({ status: 'failed', error: new Error('不可直接展示的网络详情') }) })[1];
  assert.equal(failed.bodyState, 'error');
  assert.equal(failed.process.active, false);
  assert.match(failed.notice.message, /重新连接消息/);
  assert.doesNotMatch(failed.notice.message, /网络详情/);
  assert.equal(submission.remote.result.status, 'completed');
});
