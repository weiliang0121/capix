import test from 'node:test';
import assert from 'node:assert/strict';
import { installFrames } from './frames.mjs';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { createAppStore } from '../../apps/observer/.test-dist/state/store.js';
import { submitDraft } from '../../apps/observer/.test-dist/binding/submit.js';
import { client, deferred, transport } from '../client/fixtures.mjs';

const waitForStop = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));
const responseFor = (app, id) => app.store.getState().data.conversation.find((row) => row.kind === 'response' && row.submissionId === id);

test('application accepts waiting input, can withdraw it, and automatically sends the next item', async (t) => {
  const frames = installFrames(t);
  const gate = deferred();
  const sent = [];
  const io = transport({
    submit: async (request, receive) => {
      sent.push(request);
      const delivery = io.delivery(request, receive);
      delivery.input();
      if (sent.length === 1) await gate.promise;
      delivery.complete();
    },
    cancel: async () => assert.fail('Waiting input is withdrawn without a remote cancellation'),
  });
  const runtime = client({ conversation: io });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  app.store.getState().setDraft('第一条');
  await app.commands.submit();
  const focus = app.store.getState().conversationFocus;
  assert.equal(typeof focus, 'string');
  await frames.flush();
  assert.equal(focus, runtime.getSnapshot().submission.queueId);
  assert.notEqual(focus, sent[0].submissionId);
  app.store.getState().setDraft('第二条');
  app.store.getState().setBudget('8192');
  await app.commands.submit();
  await frames.flush();
  assert.equal(sent.length, 1);
  assert.equal(app.store.getState().draft, '');
  assert.equal(app.store.getState().conversationFocus, focus, 'queued input does not move the reader to the latest message');
  assert.equal(app.store.getState().data.queue.waiting[0].pending, '第二条');
  assert.equal(app.store.getState().data.messageCount, 1, 'waiting input is not a formal transcript message');
  assert.equal(app.store.getState().data.conversation.filter((row) => row.kind === 'response').length, 1, 'waiting input has no running response region');
  await app.commands.cancelSubmission(app.store.getState().data.queue.waiting[0].id);
  await frames.flush();
  assert.equal(app.store.getState().data.queue.waiting.length, 0);
  app.store.getState().setDraft('第三条');
  await app.commands.submit();
  await frames.flush();
  assert.equal(sent.length, 1);
  assert.equal(app.store.getState().conversationFocus, focus, 'waiting input does not move the reader');
  gate.resolve();
  await frames.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].input.messages[0].content, '第三条');
  assert.equal(sent[1].input.contextBudget, 8192);
  assert.equal(app.store.getState().conversationFocus, focus, 'automatically dispatched input does not create a new scroll intent');
  disconnect();
});

test('active cancellation bypasses waiting input and acknowledgement does not announce termination', async (t) => {
  const frames = installFrames(t);
  const sent = [];
  const cancelled = [];
  let latest;
  let receiveActive;
  const io = transport({
    submit: async (request, receive, signal) => {
      sent.push(request);
      const delivery = io.delivery(request, receive);
      delivery.input();
      if (sent.length > 1) {
        delivery.complete();
        return;
      }
      latest = delivery.snapshot;
      receiveActive = receive;
      await waitForStop(signal);
    },
    cancel: async (id) => {
      cancelled.push(id);
      latest = { ...latest, revision: latest.revision + 1, cancelRequested: true };
      return latest;
    },
  });
  const runtime = client({ conversation: io });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  app.store.getState().setDraft('正在处理');
  await app.commands.submit();
  await frames.flush();
  const activeId = app.store.getState().data.submissionControl.id;
  app.store.getState().setDraft('等待下一轮');
  await app.commands.submit();
  await app.commands.cancelSubmission(activeId);
  await frames.flush();
  assert.deepEqual(cancelled, [activeId]);
  assert.equal(sent.length, 1);
  assert.equal(app.store.getState().data.busy, true);
  assert.equal(app.store.getState().data.queue.waiting.length, 1);
  assert.match(responseFor(app, activeId).notice.message, /服务已接收取消请求.*实际结束/);
  receiveActive({ ...latest, revision: latest.revision + 1, result: { status: 'cancelled' } });
  await frames.flush();
  assert.equal(app.store.getState().data.busy, false);
  assert.equal(sent.length, 2, 'the actual terminal result allows the waiting item to start');
  assert.match(responseFor(app, activeId).notice.message, /处理已取消/);
  disconnect();
});

test('stopping current preserves waiting input and an uncertain cancellation cannot advance the queue', async (t) => {
  const frames = installFrames(t);
  const gate = deferred();
  let posts = 0;
  const io = transport({
    submit: async (request, receive, signal) => {
      posts++;
      io.delivery(request, receive).input();
      await waitForStop(signal);
    },
    cancel: async () => gate.promise,
  });
  const runtime = client({ conversation: io });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  app.store.getState().setDraft('正在处理');
  await app.commands.submit();
  await frames.flush();
  const activeId = app.store.getState().data.submissionControl.id;
  app.store.getState().setDraft('待发送');
  await app.commands.submit();
  const cancelling = app.commands.cancelSubmission(activeId);
  await frames.flush();
  assert.equal(app.store.getState().data.queue.waiting.length, 1);
  assert.equal(app.store.getState().data.busy, true);
  gate.reject(new Error('取消响应丢失'));
  await cancelling;
  await frames.flush();
  assert.equal(posts, 1);
  assert.equal(app.store.getState().data.busy, true);
  assert.match(responseFor(app, activeId).notice.message, /取消请求是否送达尚未确认/);
  assert.equal(app.store.getState().data.submissionControl.label, '重试停止当前回答');
  runtime.stopFollowing();
  disconnect();
});

test('local queue rejection retains input and reentrant local acceptance does not erase newer edits', async () => {
  const store = createAppStore();
  store.getState().setDraft('保留草稿');
  store.getState().setHistory('[{"role":"assistant","content":"历史"}]');
  const runtime = {
    getSnapshot: () => ({ config: { configured: true }, busy: false, queue: { waiting: [] } }),
    enqueue: () => {
      throw new Error('待发送队列已满');
    },
  };
  await submitDraft(store, runtime);
  assert.equal(store.getState().draft, '保留草稿');
  assert.match(store.getState().history, /历史/);
  assert.match(store.getState().notice, /队列已满/);
  assert.equal(store.getState().conversationFocus, undefined, 'rejected local input does not request scrolling');
  runtime.enqueue = () => {
    store.getState().setDraft('新编辑');
    store.getState().setHistory('[{"role":"user","content":"新的历史"}]');
    return { id: 'accepted-locally' };
  };
  await submitDraft(store, runtime);
  assert.equal(store.getState().draft, '新编辑');
  assert.match(store.getState().history, /新的历史/);
  assert.equal(store.getState().notice, '');
  assert.equal(store.getState().conversationFocus, 'accepted-locally');
});

test('send scroll intent only follows immediate local submission, not blocked or waiting work', async () => {
  const cases = [
    { busy: true, queue: { waiting: [] } },
    { busy: false, queue: { waiting: [{ id: 'older', pending: '先前的消息' }] } },
    { busy: false, queue: { waiting: [], blocked: '服务正在等待恢复' } },
  ];
  for (const observed of cases) {
    const store = createAppStore();
    store.setState({ draft: '下一条', conversationFocus: 'previous' });
    await submitDraft(store, { getSnapshot: () => ({ config: { configured: true }, ...observed }), enqueue: () => ({ id: 'next' }) });
    assert.equal(store.getState().draft, '');
    assert.equal(store.getState().conversationFocus, 'previous');
  }
});

test('a model failure stays in its response while the next local input sends automatically', async (t) => {
  const frames = installFrames(t);
  const gate = deferred();
  const sent = [];
  const io = transport({
    submit: async (request, receive) => {
      sent.push(request);
      const delivery = io.delivery(request, receive);
      delivery.input();
      if (sent.length === 1) {
        await gate.promise;
        delivery.fail('MODEL_FAILED', '模型暂时失败');
      } else {
        delivery.answer('下一条的回答');
        delivery.complete();
      }
    },
  });
  const runtime = client({ conversation: io });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  t.after(disconnect);
  await runtime.initialize();
  app.store.getState().setDraft('第一条');
  await app.commands.submit();
  await frames.flush();
  const first = sent[0].submissionId;
  app.store.getState().setDraft('第二条');
  await app.commands.submit();
  gate.resolve();
  await frames.flush();
  assert.equal(sent.length, 2);
  assert.equal(app.store.getState().data.queue.waiting.length, 0);
  assert.equal(app.store.getState().data.queue.blocked, undefined);
  assert.match(responseFor(app, first).notice.message, /未能完成回答/);
  assert.equal(responseFor(app, sent[1].submissionId).body.message.content, '下一条的回答');
  assert.equal(app.store.getState().data.submissionControl, undefined);
});
