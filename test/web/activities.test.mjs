import test from 'node:test';
import assert from 'node:assert/strict';
import { createDataProjection } from '../../apps/observer/.test-dist/binding/data.js';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { projectConversationActivities } from '../../apps/observer/.test-dist/binding/activities.js';
import { client, transport, submissionSnapshot } from '../client/fixtures.mjs';
import { installFrames } from './frames.mjs';

const startedAt = '2026-10-11T00:00:00.000Z';
const finishedAt = '2026-10-11T00:00:00.010Z';
const input = { transcriptId: 'fixture-transcript', start: 0, end: 1 };
const call = (contextId, level, parentContextId, patch = {}) => ({ contextId, level, ...(parentContextId ? { parentContextId } : {}), label: contextId, status: 'running', phase: 'execute', round: 1, startedAt, ...patch });
const calls = () => [call('runtime', 'runtime'), call('execution', 'execution', 'runtime'), call('answer', 'operation', 'execution', { label: '生成回答' }), call('model-1', 'attempt', 'answer', { label: '调用模型' })];
const activities = (items, integrity = { status: 'complete' }) => ({ calls: items, integrity });
const submission = (patch = {}) => ({ id: 'first', pending: '问题', feedback: { status: 'following' }, remote: submissionSnapshot('first', { input, activities: activities(calls()), ...patch }) });
const state = (value) => ({ transcriptId: input.transcriptId, submission: value, submissions: new Map([[value.id, value]]) });
const messages = [
  { key: 'message-0', index: 0, message: { role: 'user', content: '问题' } },
  { key: 'message-1', index: 1, message: { role: 'assistant', content: '回答' } },
];

test('conversation process is associated by formal message locator, without observation or duplicated content', () => {
  const value = submission();
  const projection = projectConversationActivities(messages, state(value));
  assert.equal(projection.conversation.length, 2);
  assert.equal(projection.conversation[0].processes[0].id, 'first');
  assert.equal(projection.conversation[1], messages[1]);
  assert.equal(messages[0].processes, undefined);
  assert.equal(projection.conversation[0].processes[0].label, '正在生成回答 · 调用模型');
  assert.equal('calls' in projection.conversation[0].processes[0], false);
  const pending = projectConversationActivities([], state(value));
  assert.equal(pending.conversation.length, 0);
  assert.equal(pending.pendingProcesses[0].inputPending, true);
  const unrelated = projectConversationActivities(messages, { ...state(value), transcriptId: 'another-transcript' });
  assert.equal(unrelated.pendingProcesses.length, 0);
  assert.equal(unrelated.conversation[0].processes, undefined);
});

test('one current hint replaces finished steps and carries the operation purpose through retry', () => {
  const items = calls();
  items[3] = { ...items[3], status: 'succeeded', finishedAt, relation: { phase: 'failed', returned: 'succeeded' } };
  const failed = projectConversationActivities(messages, state(submission({ activities: activities(items) }))).conversation[0].processes[0];
  assert.equal(failed.label, '生成回答 · 正在处理结果接纳失败');
  items.push(call('model-2', 'attempt', 'answer', { label: '调用模型' }));
  items[2] = { ...items[2], round: 2 };
  const retried = projectConversationActivities(messages, state(submission({ activities: activities(items) }))).conversation[0].processes[0];
  assert.equal(retried.label, '正在生成回答 · 调用模型（第 2 次尝试）');
  assert.equal('calls' in retried, false);
  assert.equal(items[3].relation.phase, 'failed', 'presentation does not discard earlier runtime facts');
});

test('returned child work is not an accepted result or a completed submission', () => {
  const items = calls();
  items[3] = { ...items[3], status: 'succeeded', finishedAt, relation: { phase: 'returned', returned: 'succeeded' } };
  const waiting = projectConversationActivities(messages, state(submission({ activities: activities(items) }))).conversation[0].processes[0];
  assert.equal(waiting.label, '生成回答 · 正在处理结果');
  items[3].relation = { phase: 'accepted', returned: 'succeeded' };
  const accepted = projectConversationActivities(messages, state(submission({ activities: activities(items) }))).conversation[0].processes[0];
  assert.equal(accepted.label, '正在生成回答');
  assert.equal(accepted.active, true);
  const finished = items.map((item) => ({ ...item, status: 'succeeded', finishedAt }));
  const noResult = projectConversationActivities(messages, state(submission({ activities: activities(finished) }))).conversation[0].processes[0];
  assert.equal(noResult.label, '等待处理结果');
});

test('cancellation acknowledgement and disconnected progress cannot fabricate completed or cancelled calls', () => {
  const requested = submission({ cancelRequested: true });
  const waiting = projectConversationActivities(messages, state(requested)).conversation[0].processes[0];
  assert.equal(waiting.label, '等待取消结果');
  assert.equal(waiting.active, true);
  const disconnected = { ...requested, feedback: { status: 'interrupted', error: new Error('断流') } };
  const unknown = projectConversationActivities(messages, state(disconnected)).conversation[0].processes[0];
  assert.equal(unknown.active, false);
  assert.equal(unknown.label, '连接中断，结果待确认');
  assert.match(unknown.notice, /最后收到的进展：正在生成回答/);
  const cancelled = { ...requested, remote: { ...requested.remote, result: { status: 'cancelled' } } };
  const ended = projectConversationActivities(messages, state(cancelled)).conversation[0].processes[0];
  assert.equal(ended.label, '处理已取消');
  assert.equal(ended.active, false);
  assert.match(ended.notice, /结束状态尚未取得/);
});

test('process integrity diagnosis survives a successful submission result without relabelling its calls', () => {
  const incomplete = submission({ result: { status: 'completed' }, activities: activities(calls(), { status: 'incomplete', error: { code: 'INCOMPLETE', message: '过程来源缺失' } }) });
  const process = projectConversationActivities(messages, state(incomplete)).conversation[0].processes[0];
  assert.equal(process.label, '处理完成');
  assert.equal(process.active, false);
  assert.match(process.notice, /过程信息不完整：过程来源缺失/);
  assert.match(process.notice, /部分调用的结束状态尚未取得/);
});

test('reconnecting retains stale call labels until a fresh feedback snapshot is accepted', () => {
  const value = { ...submission(), feedback: { status: 'connecting' } };
  const reconnecting = projectConversationActivities(messages, state(value)).conversation[0].processes[0];
  assert.equal(reconnecting.label, '正在同步处理状态');
  assert.equal(reconnecting.active, false);
  assert.match(reconnecting.notice, /最后收到的进展：正在生成回答/);
  const following = projectConversationActivities(messages, state({ ...value, feedback: { status: 'following' } })).conversation[0].processes[0];
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
      const delivery = io.delivery(request, (snapshot) => receive({ ...snapshot, activities: activities(items) }));
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
    data.conversation.map((row) => row.message.content),
    ['第一条', '回答 1', '第二条', '回答 2'],
  );
  assert.equal(data.conversation[0].processes[0].label, '处理完成');
  assert.equal(data.conversation[2].processes[0].label, '处理完成');
  assert.equal(runtime.getSnapshot().submissions.values().next().value.remote.activities.calls.length, 4);
  assert.equal('calls' in data.conversation[0].processes[0], false);
  assert.notEqual(data.conversation[0].processes[0].id, data.conversation[2].processes[0].id);
  assert.equal(data.conversation[1].processes, undefined);
  assert.equal(data.pendingProcesses.length, 0);
  assert.equal(data.rounds.length, 0);
});

test('unchanged submission facts retain conversation read model identity', () => {
  const runtime = client({ conversation: transport() });
  const initial = runtime.getSnapshot();
  const project = createDataProjection();
  const first = project(initial);
  const second = project({ ...initial, queue: { waiting: [], paused: true } });
  assert.equal(first.conversation, second.conversation);
  assert.equal(first.pendingProcesses, second.pendingProcesses);
});

test('releasing a terminal submission without accepted input removes its unanchored process', () => {
  const runtime = client({ conversation: transport() });
  const initial = runtime.getSnapshot();
  const rejected = submission({ input: undefined, result: { status: 'rejected', error: { code: 'INVALID_INPUT', message: '输入无效' } }, activities: activities([call('runtime', 'runtime', undefined, { status: 'failed', finishedAt })]) });
  const retained = new Map([[rejected.id, rejected]]);
  const project = createDataProjection();
  const before = project({ ...initial, submission: rejected, submissions: retained });
  assert.equal(before.pendingProcesses.length, 1);
  const after = project({ ...initial, submission: undefined, submissions: retained });
  assert.equal(after.pendingProcesses.length, 0);
});

test('successful work and failed delivery are labelled as separate facts', () => {
  const items = calls();
  items[3] = { ...items[3], status: 'succeeded', finishedAt, relation: { phase: 'returned', returned: 'failed' } };
  const process = projectConversationActivities(messages, state(submission({ activities: activities(items) }))).conversation[0].processes[0];
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
  assert.equal(data.conversation[0].processes[0].label, '正在提取记忆体 · 调用模型');
  assert.equal(data.progress, '', 'only one loading cue is shown for the current submission');
  const failed = { ...value, remote: { ...value.remote, result: { status: 'failed', error: { code: 'MEMORY_FAILED', message: 'fixture' } } } };
  const ended = projectConversationActivities(messages, state(failed)).conversation[0].processes[0];
  assert.equal(ended.label, '回答已保留，后续处理失败');
  assert.equal(ended.active, false);
});

test('a retained older process does not suppress submission feedback before new activity arrives', () => {
  const runtime = client({ conversation: transport() });
  const initial = runtime.getSnapshot();
  const previous = submission({ result: { status: 'completed' } });
  const current = { id: 'second', pending: '第二条', feedback: { status: 'connecting' } };
  const data = createDataProjection()({ ...initial, ...state(previous), messages: messages.map((row) => row.message), submission: current });
  assert.equal(data.progress, '正在提交…');
});
