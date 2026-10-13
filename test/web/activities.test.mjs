import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataProjection } from '../../apps/observer/.test-dist/binding/data.js';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { projectConversationProcess } from '../../apps/observer/.test-dist/binding/activities.js';
import { createResponseProjection } from '../../apps/observer/.test-dist/binding/responses.js';
import { client, transport, submissionSnapshot } from '../client/fixtures.mjs';
import { installFrames } from './frames.mjs';

const projectResponses = (messages, state) => createResponseProjection()(messages, state);

const startedAt = '2026-10-11T00:00:00.000Z';
const finishedAt = '2026-10-11T00:00:00.010Z';
const input = { transcriptId: 'fixture-transcript', start: 0, end: 1 };
const call = (contextId, level, parentContextId, patch = {}) => ({ contextId, level, ...(parentContextId ? { parentContextId } : {}), label: contextId, status: 'running', phase: 'execute', round: 1, startedAt, ...patch });
const calls = () => [call('runtime', 'runtime'), call('execution', 'execution', 'runtime'), call('answer', 'operation', 'execution', { label: '生成回答' }), call('model-1', 'attempt', 'answer', { label: '调用模型' })];
const activities = (items, integrity = { status: 'complete' }) => ({ calls: items, integrity });
const submission = (patch = {}) => ({ id: 'first', queueId: 'local-first', pending: '问题', feedback: { status: 'following' }, remote: submissionSnapshot('first', { input, activities: activities(calls()), ...patch }) });
const state = (value) => ({ ...client({ conversation: transport() }).getSnapshot(), transcriptId: input.transcriptId, submission: value, submissions: new Map([[value.id, value]]) });
const messages = [
  { key: 'message-0', index: 0, message: { role: 'user', content: '问题' } },
  { key: 'message-1', index: 1, message: { role: 'assistant', content: '回答' } },
];

test('response region owns progress and joins formal content through locators without observation', () => {
  const value = submission({ answer: { transcriptId: input.transcriptId, index: 1 } });
  const projection = projectResponses(messages, state(value));
  assert.equal(projection.length, 2);
  assert.equal(projection[0].kind, 'message');
  assert.equal(projection[1].kind, 'response');
  assert.equal(projection[1].submissionId, 'first');
  assert.equal(projection[1].body, messages[1]);
  assert.equal(projection[1].afterInputKey, messages[0].key);
  assert.equal(messages[0].processes, undefined);
  assert.equal(projection[1].process.label, '正在生成回答 · 调用模型');
  assert.equal('calls' in projection[1].process, false);
  const pending = projectResponses([], state(value));
  assert.equal(pending[0].kind, 'pending-input');
  assert.equal(pending[0].label, '输入已接纳，正文待同步');
  assert.equal(pending[1].kind, 'response');
  assert.equal(pending[1].body, undefined);
  const unrelated = projectResponses(messages, { ...state(value), transcriptId: 'another-transcript' });
  assert.ok(unrelated.every((item) => item.kind === 'message'));
});

test('one current hint replaces finished steps and carries the operation purpose through retry', () => {
  const items = calls();
  items[3] = { ...items[3], status: 'succeeded', finishedAt, relation: { phase: 'failed', returned: 'succeeded' } };
  const failed = projectConversationProcess(submission({ activities: activities(items) }));
  assert.equal(failed.label, '生成回答 · 正在处理结果接纳失败');
  items.push(call('model-2', 'attempt', 'answer', { label: '调用模型' }));
  items[2] = { ...items[2], round: 2 };
  const retried = projectConversationProcess(submission({ activities: activities(items) }));
  assert.equal(retried.label, '正在生成回答 · 调用模型（第 2 次尝试）');
  assert.equal('calls' in retried, false);
  assert.equal(items[3].relation.phase, 'failed', 'presentation does not discard earlier runtime facts');
});

test('returned child work is not an accepted result or a completed submission', () => {
  const items = calls();
  items[3] = { ...items[3], status: 'succeeded', finishedAt, relation: { phase: 'returned', returned: 'succeeded' } };
  const waiting = projectConversationProcess(submission({ activities: activities(items) }));
  assert.equal(waiting.label, '生成回答 · 正在处理结果');
  items[3].relation = { phase: 'accepted', returned: 'succeeded' };
  const accepted = projectConversationProcess(submission({ activities: activities(items) }));
  assert.equal(accepted.label, '正在生成回答');
  assert.equal(accepted.active, true);
  const finished = items.map((item) => ({ ...item, status: 'succeeded', finishedAt }));
  const noResult = projectConversationProcess(submission({ activities: activities(finished) }));
  assert.equal(noResult.label, '等待处理结果');
});

test('cancellation acknowledgement and disconnected progress cannot fabricate completed or cancelled calls', () => {
  const requested = submission({ cancelRequested: true });
  const waiting = projectConversationProcess(requested);
  assert.equal(waiting.label, '等待取消结果');
  assert.equal(waiting.active, true);
  const disconnected = { ...requested, feedback: { status: 'interrupted', error: new Error('断流') } };
  const unknown = projectConversationProcess(disconnected);
  assert.equal(unknown.active, false);
  assert.equal(unknown.label, '连接中断，结果待确认');
  assert.match(unknown.notice, /最后收到的进展：正在生成回答/);
  const cancelled = { ...requested, remote: { ...requested.remote, result: { status: 'cancelled' } } };
  const ended = projectConversationProcess(cancelled);
  assert.equal(ended.label, '处理已取消');
  assert.equal(ended.active, false);
  assert.match(ended.notice, /结束状态尚未取得/);
});

test('process integrity diagnosis survives a successful submission result without relabelling its calls', () => {
  const incomplete = submission({ result: { status: 'completed' }, activities: activities(calls(), { status: 'incomplete', error: { code: 'INCOMPLETE', message: '过程来源缺失' } }) });
  const process = projectConversationProcess(incomplete);
  assert.equal(process.label, '处理完成');
  assert.equal(process.active, false);
  assert.match(process.notice, /过程信息不完整：过程来源缺失/);
  assert.match(process.notice, /部分调用的结束状态尚未取得/);
});

test('reconnecting retains stale call labels until a fresh feedback snapshot is accepted', () => {
  const value = { ...submission(), feedback: { status: 'connecting' } };
  const reconnecting = projectConversationProcess(value);
  assert.equal(reconnecting.label, '正在同步处理状态');
  assert.equal(reconnecting.active, false);
  assert.match(reconnecting.notice, /最后收到的进展：正在生成回答/);
  const following = projectConversationProcess({ ...value, feedback: { status: 'following' } });
  assert.equal(following.active, true);
  assert.equal(following.label, '正在生成回答 · 调用模型');
  assert.equal(following.notice, undefined);
});

test('frame coalescing keeps runtime facts but only publishes compact results for each submission', async (t) => {
  const frames = installFrames(t);
  let number = 0;
  const io = transport({
    submit: async (request, receive) => {
      number++;
      let items = calls().map((item) => ({ ...item, contextId: `${item.contextId}-${number}`, ...(item.parentContextId ? { parentContextId: `${item.parentContextId}-${number}` } : {}) }));
      const delivery = io.delivery(request, (frame) => receive(frame.type === 'baseline' ? { ...frame, submission: { ...frame.submission, activities: activities(items) } } : frame.type === 'submission' ? { ...frame, change: { ...frame.change, activities: { calls: items, integrity: { status: 'complete' } } } } : frame));
      delivery.input();
      items = items.map((item) => ({ ...item, status: 'succeeded', finishedAt, ...(item.parentContextId ? { relation: { phase: 'accepted', returned: 'succeeded' } } : {}) }));
      delivery.answer(`回答 ${number}`);
      delivery.complete();
    },
  });
  const runtime = client({ conversation: io });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  t.after(disconnect);
  await runtime.initialize();
  await runtime.submit({ messages: [{ role: 'user', content: '第一条' }] });
  await runtime.submit({ messages: [{ role: 'user', content: '第二条' }] });
  await frames.flush();
  const data = app.store.getState().data;
  assert.equal(runtime.getSnapshot().observation.enabled, false);
  assert.equal(data.messageCount, 4);
  assert.deepEqual(
    data.conversation.map((row) => (row.kind === 'message' ? row.message.content : row.body.message.content)),
    ['第一条', '回答 1', '第二条', '回答 2'],
  );
  assert.equal(data.conversation[1].process, undefined);
  assert.equal(data.conversation[3].process, undefined);
  assert.equal(runtime.getSnapshot().submissions.values().next().value.remote.activities.calls.length, 4);
  assert.notEqual(data.conversation[1].submissionId, data.conversation[3].submissionId);
  assert.ok(data.conversation.every((item) => item.kind !== 'pending-input'));
  assert.equal(data.rounds.length, 0);
});

test('unchanged submission facts retain conversation read model identity', () => {
  const runtime = client({ conversation: transport() });
  const initial = runtime.getSnapshot();
  const project = createDataProjection();
  const first = project(initial);
  const second = project({ ...initial, queue: { waiting: [] } });
  assert.equal(first.conversation, second.conversation);
});

test('releasing a terminal submission without accepted input removes its unanchored process', () => {
  const runtime = client({ conversation: transport() });
  const initial = runtime.getSnapshot();
  const rejected = submission({ input: undefined, result: { status: 'rejected', error: { code: 'INVALID_INPUT', message: '输入无效' } }, activities: activities([call('runtime', 'runtime', undefined, { status: 'failed', finishedAt })]) });
  const retained = new Map([[rejected.id, rejected]]);
  const project = createDataProjection();
  const before = project({ ...initial, submission: rejected, submissions: retained });
  assert.equal(before.conversation.filter((item) => item.kind === 'response').length, 1);
  const after = project({ ...initial, submission: undefined, submissions: retained });
  assert.equal(after.conversation.length, 0);
});

test('successful work and failed delivery are labelled as separate facts', () => {
  const items = calls();
  items[3] = { ...items[3], status: 'succeeded', finishedAt, relation: { phase: 'returned', returned: 'failed' } };
  const process = projectConversationProcess(submission({ activities: activities(items) }));
  assert.equal(process.label, '生成回答 · 正在处理调用失败');
  assert.equal(process.active, true);
});

test('new operation replaces prior purpose, and answer delivery does not imply all work has ended', () => {
  const runtime = client({ conversation: transport() });
  const initial = runtime.getSnapshot();
  const items = calls();
  items[2] = { ...items[2], status: 'succeeded', finishedAt, relation: { phase: 'accepted', returned: 'succeeded' } };
  items[3] = { ...items[3], status: 'succeeded', finishedAt, relation: { phase: 'accepted', returned: 'succeeded' } };
  items.push(call('memory', 'operation', 'execution', { label: '提取记忆体' }));
  items.push(call('memory-model', 'attempt', 'memory', { label: '调用模型' }));
  const value = submission({ answer: { transcriptId: input.transcriptId, index: 1 }, activities: activities(items) });
  const data = createDataProjection()({ ...initial, ...state(value), messages: messages.map((row) => row.message), answerAvailability: 'available' });
  assert.equal(data.conversation.find((item) => item.kind === 'response').process.label, '正在提取记忆体 · 调用模型');
  assert.equal('progress' in data, false, 'no second global loading cue is published');
  const failed = { ...value, remote: { ...value.remote, result: { status: 'failed', error: { code: 'MEMORY_FAILED', message: 'fixture' } } } };
  const ended = projectConversationProcess(failed);
  assert.equal(ended.label, '回答已保留，后续处理失败');
  assert.equal(ended.active, false);
});

test('a retained older process does not suppress submission feedback before new activity arrives', () => {
  const runtime = client({ conversation: transport() });
  const initial = runtime.getSnapshot();
  const previous = submission({ result: { status: 'completed' } });
  const current = { id: 'second', queueId: 'local-second', pending: '第二条', feedback: { status: 'connecting' } };
  const data = createDataProjection()({ ...initial, ...state(previous), messages: messages.map((row) => row.message), submission: current });
  assert.equal(data.conversation.find((item) => item.kind === 'response' && item.submissionId === 'second').process.label, '正在提交…');
});

test('a dispatched request establishes its response before activity or acceptance, while queued input does not', () => {
  const initial = client({ conversation: transport() }).getSnapshot();
  const waiting = { ...initial, queue: { waiting: [{ id: 'queued', queueId: 'local-queued', pending: '排队输入' }] } };
  assert.deepEqual(projectResponses([], waiting), []);
  const idle = { id: 'local', queueId: 'local-local', pending: '问题', feedback: { status: 'idle' } };
  assert.deepEqual(projectResponses([], { ...waiting, submission: idle }), []);
  const connecting = { ...idle, feedback: { status: 'connecting' } };
  const items = projectResponses([], { ...waiting, submission: connecting });
  assert.deepEqual(
    items.map((item) => item.kind),
    ['pending-input', 'response'],
  );
  assert.equal(items[0].content, '问题');
  assert.equal(items[1].process.label, '正在提交…');
  assert.equal(items[1].process.active, true);
  assert.equal(items[1].body, undefined);
  assert.equal(items[1].afterInputKey, items[0].key);
});

test('terminal submissions without input confirmation never remain labelled as an unknown submission', () => {
  const outcomes = [
    [{ status: 'cancelled' }, '已取消'],
    [{ status: 'failed', error: { code: 'SETUP_FAILED', message: '初始化失败' } }, '处理失败'],
    [{ status: 'rejected', error: { code: 'RUNTIME_BUSY', message: '服务忙碌' } }, '未被接纳'],
  ];
  for (const [result, label] of outcomes) {
    const value = { ...submission({ input: undefined, activities: undefined, cancelRequested: result.status === 'cancelled' ? true : undefined, result }), feedback: { status: 'ended' } };
    const items = projectResponses([], state(value));
    assert.equal(items[0].kind, 'pending-input');
    assert.equal(items[0].content, value.pending);
    assert.equal(items[0].label, label);
    assert.equal(items[1].process, undefined);
    assert.equal(items[1].notice.reconnect, false);
  }
});

test('a terminal submission with accepted input still identifies pending transcript synchronization', () => {
  for (const result of [{ status: 'cancelled' }, { status: 'failed', error: { code: 'SETUP_FAILED', message: '初始化失败' } }]) {
    const value = { ...submission({ activities: undefined, cancelRequested: result.status === 'cancelled' ? true : undefined, result }), feedback: { status: 'ended' } };
    const items = projectResponses([], state(value));
    assert.equal(items[0].label, '输入已接纳，正文待同步');
    assert.equal(items[1].process, undefined);
    assert.equal(items[1].notice.reconnect, false);
  }
});

test('the response identity remains stable across local input, formal acceptance and answer body', () => {
  const initial = client({ conversation: transport() }).getSnapshot();
  const connecting = { id: 'stable', queueId: 'local-stable', pending: '问题', feedback: { status: 'connecting' } };
  const start = projectResponses([], { ...initial, submission: connecting }).find((item) => item.kind === 'response');
  const accepted = { ...connecting, feedback: { status: 'following' }, remote: submissionSnapshot('stable', { input }) };
  const inputState = { ...initial, transcriptId: input.transcriptId, submission: accepted, submissions: new Map([[accepted.id, accepted]]) };
  const middle = projectResponses(messages.slice(0, 1), inputState);
  assert.deepEqual(
    middle.map((item) => item.kind),
    ['message', 'response'],
  );
  assert.equal(middle[1].key, start.key);
  assert.equal(middle[1].afterInputKey, messages[0].key);
  const answered = { ...accepted, remote: { ...accepted.remote, answer: { transcriptId: input.transcriptId, index: 1 }, result: { status: 'completed' } } };
  const final = projectResponses(messages, { ...inputState, submission: answered, submissions: new Map([[answered.id, answered]]) });
  assert.equal(final[1].key, start.key);
  assert.equal(final[1].body, messages[1]);
  assert.equal(final[1].process, undefined);
  assert.equal(final[1].notice, undefined);
  assert.equal(messages[1].message.content, '回答');
});

test('a body received before its locator stays visible and is merged without duplication or replay', () => {
  const initial = client({ conversation: transport() }).getSnapshot();
  const project = createDataProjection();
  project({ ...initial, transcriptId: input.transcriptId });
  const accepted = { id: 'late-location', queueId: 'local-late-location', pending: '问题', feedback: { status: 'following' }, remote: submissionSnapshot('late-location', { input }) };
  const before = project({ ...initial, transcriptId: input.transcriptId, messages: messages.map((row) => row.message), submission: accepted, submissions: new Map([[accepted.id, accepted]]) });
  assert.deepEqual(
    before.conversation.map((item) => item.kind),
    ['message', 'response', 'message'],
  );
  const displayed = before.conversation[2];
  assert.equal(displayed.reveal, undefined);
  const located = { ...accepted, remote: { ...accepted.remote, answer: { transcriptId: input.transcriptId, index: 1 } } };
  const after = project({ ...initial, transcriptId: input.transcriptId, messages: messages.map((row) => row.message), submission: located, submissions: new Map([[located.id, located]]) });
  assert.deepEqual(
    after.conversation.map((item) => item.kind),
    ['message', 'response'],
  );
  assert.equal(after.conversation[1].key, before.conversation[1].key);
  assert.equal(after.conversation[1].body.key, displayed.key);
  assert.equal(after.conversation[1].body.reveal, undefined);
  assert.equal(after.conversation[1].body.message, displayed.message);
});

test('completed work continues to report pending body synchronization, then leaves only its formal answer', () => {
  const value = submission({ activities: undefined, answer: { transcriptId: input.transcriptId, index: 1 }, result: { status: 'completed' } });
  const view = { ...state(value), transcripts: new Map([[input.transcriptId, { sync: { status: 'live' } }]]) };
  const pending = projectResponses(messages.slice(0, 1), view)[1];
  assert.equal(pending.body, undefined);
  assert.match(pending.process.label, /处理已完成.*正文待同步/);
  assert.equal(pending.process.active, true);
  assert.equal(pending.bodyState, 'pending');
  const stopped = projectResponses(messages.slice(0, 1), { ...view, transcripts: new Map([[input.transcriptId, { sync: { status: 'stopped' } }]]) })[1];
  assert.equal(stopped.process.active, false);
  assert.equal(stopped.bodyState, 'unloaded');
  const available = projectResponses(messages, view)[1];
  assert.equal(available.body, messages[1]);
  assert.equal(available.process, undefined);
  assert.equal(available.bodyState, 'available');
});

test('a known answer distinguishes unavailable, missing and failed entity reads without an indefinite spinner', () => {
  const value = submission({ activities: undefined, answer: { transcriptId: input.transcriptId, index: 1 }, result: { status: 'completed' } });
  const source = { id: input.transcriptId, start: 0, end: 1, revision: 1, starts: [0], messages: [messages[0].message] };
  const missing = projectResponses(messages.slice(0, 1), { ...state(value), transcripts: new Map([[input.transcriptId, { snapshot: source, sync: { status: 'stopped' } }]]) })[1];
  assert.equal(missing.bodyState, 'missing');
  assert.equal(missing.process.active, false);
  assert.match(missing.notice.message, /尚未取得对应正文/);
  const failed = projectResponses(messages.slice(0, 1), { ...state(value), transcripts: new Map([[input.transcriptId, { snapshot: source, sync: { status: 'failed', error: new Error('消息连接中断') } }]]) })[1];
  assert.equal(failed.bodyState, 'error');
  assert.equal(failed.process.active, false);
  assert.match(failed.notice.message, /正文暂未同步.*重新连接消息/);
  const cached = projectResponses(messages, { ...state(value), transcripts: new Map([[input.transcriptId, { sync: { status: 'failed', error: new Error('消息连接中断') } }]]) })[1];
  assert.equal(cached.bodyState, 'available');
  assert.equal(cached.notice, undefined);
  assert.equal(cached.process, undefined);
});

test('retained accepted failures and cancellations stay in their original response without reconnecting the wrong submission', () => {
  const failed = submission({ activities: undefined, answer: { transcriptId: input.transcriptId, index: 1 }, result: { status: 'failed', error: { code: 'POSTPROCESS', message: '后处理失败' } } });
  const initial = state(failed);
  const current = { id: 'new', queueId: 'local-new', pending: '后续问题', feedback: { status: 'connecting' } };
  const items = projectResponses(messages, { ...initial, submission: current });
  const previous = items.find((item) => item.kind === 'response' && item.submissionId === failed.id);
  assert.equal(previous.afterInputKey, messages[0].key);
  assert.equal(previous.body, messages[1]);
  assert.equal(previous.notice, undefined);
  assert.equal(previous.process, undefined);
  const cancelled = { ...failed, remote: { ...failed.remote, cancelRequested: true, result: { status: 'cancelled' } } };
  assert.match(projectResponses(messages, state(cancelled))[1].notice.message, /处理已取消/);
});

test('postprocessing failure keeps the answer and its independent synchronization states without exposing call diagnostics', () => {
  const result = { status: 'failed', error: { code: 'MEMORY_SOURCE', message: '变更后的依据必须包含本次变更依据。' } };
  const value = submission({ answer: { transcriptId: input.transcriptId, index: 1 }, result, activities: activities(calls(), { status: 'incomplete', error: { code: 'ACTIVITY_SOURCE', message: '内部过程来源失效' } }) });
  const view = state(value);
  const available = projectResponses(messages, view)[1];
  assert.equal(available.body, messages[1]);
  assert.equal(available.notice, undefined);
  assert.equal(available.process, undefined);
  assert.equal(value.remote.result, result, 'the service failure remains available for diagnosis');
  assert.equal(value.remote.activities.integrity.status, 'incomplete');
  const pending = projectResponses(messages.slice(0, 1), { ...view, transcripts: new Map([[input.transcriptId, { sync: { status: 'live' } }]]) })[1];
  assert.equal(pending.bodyState, 'pending');
  assert.equal(pending.notice, undefined);
  assert.equal(pending.process.active, true);
  assert.match(pending.process.label, /正文待同步/);
  for (const [expected, source] of [
    ['unloaded', { sync: { status: 'stopped' } }],
    ['missing', { snapshot: { end: 2 }, sync: { status: 'stopped' } }],
    ['error', { sync: { status: 'failed', error: new Error('消息连接中断') } }],
  ]) {
    const unavailable = projectResponses(messages.slice(0, 1), { ...view, transcripts: new Map([[input.transcriptId, source]]) })[1];
    assert.equal(unavailable.bodyState, expected);
    assert.equal(unavailable.process.active, false);
    assert.match(unavailable.notice.message, /正文/);
    assert.doesNotMatch(unavailable.notice.message, /依据|过程来源失效/);
  }
});

test('admission retry keeps one local response identity without displaying rejected attempts', () => {
  const initial = client({ conversation: transport() }).getSnapshot();
  const first = { id: 'attempt-one', queueId: 'local-one', pending: '稍后处理', feedback: { status: 'connecting' } };
  const start = projectResponses([], { ...initial, submission: first });
  const rejected = { ...first, feedback: { status: 'ended' }, remote: submissionSnapshot(first.id, { result: { status: 'rejected', retry: 'admission', error: { code: 'UNRELATED_CODE', message: '服务暂未就绪' } } }) };
  const waiting = { ...initial, submission: rejected, submissions: new Map([[rejected.id, rejected]]), queue: { waiting: [{ id: first.queueId, pending: first.pending }], blocked: '服务暂未就绪，等待后自动重试。' } };
  const backoff = projectResponses([], waiting);
  assert.equal(backoff.length, 2);
  assert.equal(backoff[0].key, start[0].key);
  assert.equal(backoff[0].label, '等待服务接纳');
  assert.equal(backoff[1].key, start[1].key);
  assert.equal(backoff[1].notice, undefined);
  assert.equal(backoff[1].process.label, waiting.queue.blocked);
  assert.equal(backoff[1].process.active, false);
  const second = { ...first, id: 'attempt-two' };
  const retried = projectResponses([], {
    ...waiting,
    submission: second,
    submissions: new Map([
      [rejected.id, rejected],
      [second.id, second],
    ]),
    queue: { waiting: [] },
  });
  assert.equal(retried.length, 2);
  assert.equal(retried[0].key, start[0].key);
  assert.equal(retried[1].key, start[1].key);
  assert.equal(retried[1].submissionId, second.id);
  assert.equal(retried[1].queueId, first.queueId);
  assert.equal(retried[1].process.label, '正在提交…');
  assert.deepEqual(projectResponses([], { ...waiting, queue: { waiting: [] } }), [], 'withdrawn admission waits do not leave rejected assistant replies');
});

test('changes to admission waiting reasons refresh only the current local response', () => {
  const value = { ...submission({ input: undefined, activities: undefined, result: { status: 'rejected', retry: 'admission', error: { code: 'BUSY', message: '忙碌' } } }), feedback: { status: 'ended' } };
  const waiting = { ...state(value), messages: [], queue: { waiting: [{ id: value.queueId, pending: value.pending }], blocked: '服务忙碌，等待后重试' } };
  const project = createDataProjection();
  const first = project(waiting);
  const changed = project({ ...waiting, queue: { ...waiting.queue, blocked: '正在等待可用连接' } });
  assert.equal(changed.conversation[1].key, first.conversation[1].key);
  assert.equal(changed.conversation[1].process.label, '正在等待可用连接');
  const withdrawn = project({ ...waiting, queue: { waiting: [], blocked: waiting.queue.blocked } });
  assert.deepEqual(withdrawn.conversation, []);
});
