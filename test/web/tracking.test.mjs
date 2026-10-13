import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTrackingStore } from '../../apps/observer/.test-dist/binding/tracking.js';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { createDataProjection } from '../../apps/observer/.test-dist/binding/data.js';
import { client, transport, transcriptSnapshot, submissionSnapshot } from '../client/fixtures.mjs';
import { installFrames } from './frames.mjs';

const transcriptId = 'fixture-transcript';
const conversationId = 'fixture-conversation';
const messages = [
  { role: 'user', content: '原问题' },
  { role: 'assistant', content: '已经正式保存的回答' },
];
const input = { transcriptId, start: 0, end: 1 };
const answer = { transcriptId, index: 1 };
const locator = { conversationId, transcriptId, submissionId: 'original-submission' };

function storage() {
  const data = new Map();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('session tracking retains only identity and removes a finished submission locator', () => {
  const host = storage();
  const tracking = createSessionTrackingStore(() => host);
  assert.equal(tracking.load(), undefined);
  tracking.save({ ...locator, input: { messages }, waiting: ['unsent'], preview: 'not durable' });
  assert.deepEqual(tracking.load(), locator);
  assert.equal(host.data.size, 1);
  assert.match([...host.data.keys()][0], /\.v1$/);
  assert.doesNotMatch([...host.data.values()][0], /原问题|not durable|waiting|input|preview/);
  tracking.save({ conversationId, transcriptId });
  assert.deepEqual(tracking.load(), { conversationId, transcriptId });
});

test('storage access and malformed JSON remain explicit runtime-owned errors', () => {
  const blocked = new Error('browser storage disabled');
  const tracking = createSessionTrackingStore(() => {
    throw blocked;
  });
  assert.throws(
    () => tracking.load(),
    (error) => error === blocked,
  );
  assert.throws(
    () => tracking.save(locator),
    (error) => error === blocked,
  );
  const malformed = createSessionTrackingStore(() => ({ getItem: () => '{', setItem() {} }));
  assert.throws(() => malformed.load(), SyntaxError);
});

function attachedState(patch = {}) {
  const initial = client({ conversation: transport() }).getSnapshot();
  const submission = { id: locator.submissionId, conversationId, feedback: { status: 'following' }, remote: submissionSnapshot(locator.submissionId, { input }), ...patch };
  return { ...initial, conversation: { id: conversationId, transcriptId, title: '原对话', createdAt: 1, updatedAt: 1 }, transcriptId, messages, transcripts: new Map([[transcriptId, { snapshot: transcriptSnapshot(messages), sync: { status: 'live' } }]]), submission, submissions: new Map([[submission.id, submission]]) };
}

test('attaching completed feedback preserves one static formal answer without fabricating pending input', () => {
  const project = createDataProjection();
  project(client({ conversation: transport() }).getSnapshot());
  const state = attachedState({ remote: submissionSnapshot(locator.submissionId, { input, answer, result: { status: 'completed' } }), preview: { status: 'live', snapshot: { generation: 1, revision: 5, state: 'committed', text: messages[1].content, message: answer, consistency: 'complete' } } });
  const data = project(state);
  assert.equal(data.conversation.length, 2);
  assert.equal(data.conversation[0].kind, 'message');
  const response = data.conversation[1];
  assert.equal(response.kind, 'response');
  assert.equal(response.queueId, undefined);
  assert.equal(response.body.message.content, messages[1].content);
  assert.equal(response.content.reveal, false, 'already committed history is not replayed after attaching');
  assert.equal(response.afterInputKey, data.conversation[0].key);
});

test('attached identities remain distinct and an unknown original input is never synthesized', () => {
  const project = createDataProjection();
  const state = attachedState({ remote: undefined, feedback: { status: 'connecting' } });
  const retained = { id: 'another-submission', conversationId, feedback: { status: 'ended' }, remote: submissionSnapshot('another-submission', { input, answer, result: { status: 'completed' } }) };
  const data = project({
    ...state,
    submissions: new Map([
      [retained.id, retained],
      [state.submission.id, state.submission],
    ]),
  });
  const responses = data.conversation.filter((row) => row.kind === 'response');
  assert.equal(responses.length, 2);
  assert.notEqual(responses[0].key, responses[1].key);
  assert.ok(data.conversation.every((row) => row.kind !== 'pending-input'));
  assert.equal(responses[1].afterInputKey, undefined);
  assert.equal(responses[1].process.label, '正在接回本次处理…');
});

test('unavailable original submission offers local abandonment and never pretends to cancel or finish work', () => {
  const project = createDataProjection();
  const state = attachedState({ remote: undefined, feedback: { status: 'unavailable', error: new Error('not retained') } });
  const data = project(state);
  const response = data.conversation.at(-1);
  assert.match(response.notice.message, /无法查询原提交.*不表示它未执行/);
  assert.match(response.notice.message, /不会取消服务端处理/);
  assert.equal(response.notice.reconnect, false);
  assert.equal(response.notice.abandon, true);
  assert.equal(data.submissionControl, undefined);
  assert.equal(response.process, undefined);
  const waiting = project({ ...state, queue: { waiting: [{ id: 'waiting', pending: '下一条' }] } });
  assert.equal(waiting.conversation.at(-1).notice.abandon, false);
  assert.match(waiting.conversation.at(-1).notice.message, /先撤回待发送消息/);
  assert.equal(project(state).conversation.at(-1).notice.abandon, true);
});

test('optional storage failure stays outside service outcome and leaves formal content readable', () => {
  const state = attachedState({ remote: submissionSnapshot(locator.submissionId, { input, answer, result: { status: 'completed' } }) });
  const project = createDataProjection();
  const data = project({ ...state, trackingError: new Error('QuotaExceededError') });
  assert.match(data.trackingNotice, /刷新后可能无法自动接回/);
  assert.equal(data.conversation.at(-1).body.message.content, messages[1].content);
  assert.equal(data.conversation.at(-1).notice, undefined);
  assert.equal(project(state).trackingNotice, undefined);
});

test('a recreated application uses the saved locator to query and follow without another POST', async (t) => {
  const frames = installFrames(t);
  const host = storage();
  const tracking = createSessionTrackingStore(() => host);
  tracking.save(locator);
  let posts = 0;
  let follows = 0;
  const io = transport({
    transcript: async () => transcriptSnapshot(messages.slice(0, 1)),
    read: async (id) => {
      assert.equal(id, locator.submissionId);
      return submissionSnapshot(id, { input });
    },
    follow: async (id, receive) => {
      follows++;
      assert.equal(id, locator.submissionId);
      io.appendMessages(messages.slice(1));
      receive(submissionSnapshot(id, { revision: 1, input, answer, result: { status: 'completed' } }));
    },
    submit: async () => {
      posts++;
    },
  });
  const runtime = client({ conversation: io, tracking });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  t.after(disconnect);
  await runtime.initialize();
  await frames.flush();
  assert.equal(posts, 0);
  assert.equal(follows, 1);
  assert.equal(app.store.getState().data.conversation.length, 2);
  assert.equal(app.store.getState().data.conversation[1].body.message.content, messages[1].content);
  assert.deepEqual(tracking.load(), { conversationId, transcriptId });
});
