import test from 'node:test';
import assert from 'node:assert/strict';
import { installFrames } from './frames.mjs';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { createAppStore } from '../../apps/observer/.test-dist/state/store.js';
import { submitDraft } from '../../apps/observer/.test-dist/binding/submit.js';
import { client, deferred, transport } from '../client/fixtures.mjs';

const waitForStop = (signal) => (signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true })));

test('application accepts waiting input, can withdraw it, and pause prevents the next send', async (t) => {
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
  await frames.flush();
  app.store.getState().setDraft('第二条');
  app.store.getState().setBudget('8192');
  await app.commands.submit();
  await frames.flush();
  assert.equal(sent.length, 1);
  assert.equal(app.store.getState().draft, '');
  assert.equal(app.store.getState().data.queue.waiting[0].pending, '第二条');
  assert.equal(app.store.getState().data.conversation.length, 1, 'waiting input is not a formal transcript message');
  app.commands.pauseQueue();
  gate.resolve();
  await frames.flush();
  assert.equal(sent.length, 1);
  assert.equal(app.store.getState().data.queue.paused, true);
  await app.commands.cancelSubmission(app.store.getState().data.queue.waiting[0].id);
  await frames.flush();
  assert.equal(app.store.getState().data.queue.waiting.length, 0);
  app.store.getState().setDraft('第三条');
  await app.commands.submit();
  await frames.flush();
  assert.equal(sent.length, 1);
  app.commands.resumeQueue();
  await frames.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].input.messages[0].content, '第三条');
  assert.equal(sent[1].input.contextBudget, 8192);
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
  assert.equal(app.store.getState().data.queue.paused, true);
  assert.equal(app.store.getState().data.queue.waiting.length, 1);
  assert.match(app.store.getState().data.submissionNotice.message, /服务已接收取消请求.*实际结束/);
  receiveActive({ ...latest, revision: latest.revision + 1, result: { status: 'cancelled' } });
  await frames.flush();
  assert.equal(app.store.getState().data.busy, false);
  assert.equal(sent.length, 1, 'actual cancellation keeps the queue paused');
  assert.match(app.store.getState().data.submissionNotice.message, /处理已取消/);
  app.commands.resumeQueue();
  await frames.flush();
  assert.equal(sent.length, 2);
  disconnect();
});

test('cancel all removes waiting input immediately even when remote cancellation response is lost', async (t) => {
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
  app.store.getState().setDraft('待发送');
  await app.commands.submit();
  const cancelling = app.commands.cancelAll();
  await frames.flush();
  assert.equal(app.store.getState().data.queue.waiting.length, 0);
  assert.equal(app.store.getState().data.queue.paused, true);
  assert.equal(app.store.getState().data.busy, true);
  gate.reject(new Error('取消响应丢失'));
  await cancelling;
  await frames.flush();
  assert.equal(posts, 1);
  assert.equal(app.store.getState().data.busy, true);
  assert.match(app.store.getState().data.submissionNotice.message, /取消请求是否送达尚未确认/);
  assert.equal(app.store.getState().data.submissionControl.label, '重试取消');
  runtime.stopFollowing();
  disconnect();
});

test('local queue rejection retains input and reentrant local acceptance does not erase newer edits', async () => {
  const store = createAppStore();
  store.getState().setDraft('保留草稿');
  store.getState().setHistory('[{"role":"assistant","content":"历史"}]');
  const runtime = {
    getSnapshot: () => ({ config: { configured: true } }),
    enqueue: () => {
      throw new Error('待发送队列已满');
    },
  };
  await submitDraft(store, runtime);
  assert.equal(store.getState().draft, '保留草稿');
  assert.match(store.getState().history, /历史/);
  assert.match(store.getState().notice, /队列已满/);
  runtime.enqueue = () => {
    store.getState().setDraft('新编辑');
    store.getState().setHistory('[{"role":"user","content":"新的历史"}]');
    return { id: 'accepted-locally' };
  };
  await submitDraft(store, runtime);
  assert.equal(store.getState().draft, '新编辑');
  assert.match(store.getState().history, /新的历史/);
  assert.equal(store.getState().notice, '');
});
