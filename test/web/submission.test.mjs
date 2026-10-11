import test from 'node:test';
import assert from 'node:assert/strict';
import { installFrames } from './frames.mjs';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { projectSubmission } from '../../apps/observer/.test-dist/binding/submission.js';
import { client, transport, submissionSnapshot } from '../client/fixtures.mjs';

test('application keeps a committed answer across disconnect and reconnects feedback without resubmitting', async (t) => {
  const frames = installFrames(t);
  let posts = 0;
  let follows = 0;
  let saved;
  const io = transport({
    submit: async (request, receive) => {
      posts++;
      const delivery = io.delivery(request, receive);
      delivery.input();
      delivery.execution();
      saved = delivery.answer('正式回答');
      throw new Error('连接已断开');
    },
    follow: async (id, receive) => {
      follows++;
      assert.equal(id, saved.submissionId);
      receive({ ...saved, revision: saved.revision + 3, result: { status: 'completed' } });
    },
  });
  const runtime = client({ conversation: io });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  app.store.getState().setDraft('问题');
  await app.commands.submit();
  await frames.flush();
  const pending = app.store.getState().data;
  assert.equal(pending.conversation.at(-1).message.content, '正式回答');
  assert.equal(pending.busy, true);
  assert.match(pending.submissionNotice.message, /结果待确认/);
  assert.equal(pending.submissionNotice.reconnect, true);
  assert.equal('release' in pending.submissionNotice, false);
  assert.equal(pending.submissionControl.label, '取消当前');
  assert.equal(app.store.getState().draft, '');
  await app.commands.reconnectSubmission();
  await frames.flush();
  assert.equal(posts, 1);
  assert.equal(follows, 1);
  assert.equal(app.store.getState().data.busy, false);
  assert.equal(app.store.getState().data.submissionNotice, undefined);
  assert.equal(app.store.getState().data.conversation.length, 2);
  disconnect();
});

test('unknown active result remains tracked while later locally accepted input waits', async (t) => {
  const frames = installFrames(t);
  let calls = 0;
  const runtime = client({
    conversation: transport({
      submit: async () => {
        calls++;
        throw new Error('首个响应丢失');
      },
    }),
  });
  const app = createApplication(runtime);
  const disconnect = app.connect();
  await runtime.initialize();
  app.store.getState().setDraft('未确认输入');
  await app.commands.submit();
  await frames.flush();
  assert.equal(app.store.getState().draft, '');
  assert.equal(app.store.getState().data.busy, true);
  assert.equal(app.store.getState().data.pendingLabel, '提交待确认');
  app.store.getState().setDraft('后续消息');
  await app.commands.submit();
  await frames.flush();
  assert.equal(calls, 1);
  assert.equal(app.store.getState().data.busy, true);
  assert.match(app.store.getState().data.submissionNotice.message, /结果待确认/);
  assert.equal(app.store.getState().data.queue.waiting[0].pending, '后续消息');
  assert.equal(app.store.getState().draft, '');
  assert.equal('release' in app.store.getState().data.submissionNotice, false);
  app.commands.clearQueue();
  disconnect();
});

test('application distinguishes known rejection, failed postprocessing and incomplete projection', async (t) => {
  const frames = installFrames(t);
  for (const scenario of ['rejected', 'failed', 'incomplete']) {
    const io = transport({
      submit: async (request, receive) => {
        if (scenario === 'rejected') {
          receive(submissionSnapshot(request.submissionId, { revision: 1, result: { status: 'rejected', error: { code: 'RUNTIME_BUSY', message: '服务忙碌' } } }));
          return;
        }
        const delivery = io.delivery(request, receive);
        delivery.input();
        delivery.answer('已落实回答');
        if (scenario === 'failed') delivery.fail('MEMORY_FAILED', '记忆处理失败');
        else receive({ ...delivery.snapshot, revision: delivery.snapshot.revision + 1, integrity: { status: 'incomplete', error: { code: 'SUBMISSION_INCOMPLETE', message: '进展解释已停止' } } });
      },
    });
    const runtime = client({ conversation: io });
    const app = createApplication(runtime);
    const disconnect = app.connect();
    await runtime.initialize();
    app.store.getState().setDraft('问题');
    await app.commands.submit();
    await frames.flush();
    const data = app.store.getState().data;
    assert.equal(data.busy, scenario === 'incomplete');
    assert.equal(data.submissionNotice.reconnect, scenario === 'incomplete');
    assert.equal('release' in data.submissionNotice, false);
    if (scenario === 'rejected') {
      assert.match(data.submissionNotice.message, /提交被拒绝/);
      assert.equal(data.conversation.length, 0);
      assert.equal(data.pending, '');
      assert.equal(data.submissionNotice.input, '问题', 'a rejected input remains readable outside the formal transcript');
      assert.equal(app.store.getState().draft, '');
    } else {
      assert.equal(data.conversation.at(-1).message.content, '已落实回答');
      assert.match(data.submissionNotice.message, scenario === 'failed' ? /回答已保留.*记忆处理失败/ : /进展无法完整确认/);
      assert.equal(data.submissionNotice.input, undefined, 'already committed input is not repeated in the notice');
    }
    disconnect();
  }
});

test('cancellation presentation keeps control acknowledgement separate from actual termination', () => {
  const initial = client({ conversation: transport() }).getSnapshot();
  const state = { ...initial, busy: true, submission: { id: 'current', pending: '问题', feedback: { status: 'following' }, cancellation: { status: 'acknowledged' }, remote: submissionSnapshot('current', { revision: 2, cancelRequested: true }) } };
  const pending = projectSubmission(state);
  assert.match(pending.submissionNotice.message, /服务已接收取消请求.*实际结束/);
  assert.equal(pending.submissionControl.id, 'current');
  assert.equal(pending.submissionControl.disabled, true);
  assert.equal(pending.progress, '等待取消结果…');

  const uncertain = projectSubmission({ ...state, submission: { ...state.submission, remote: undefined, feedback: { status: 'interrupted', error: new Error('断流') }, cancellation: { status: 'uncertain', error: new Error('响应丢失') } } });
  assert.match(uncertain.submissionNotice.message, /是否送达尚未确认.*响应丢失/);
  assert.equal(uncertain.submissionControl.label, '重试取消');
  assert.equal(uncertain.submissionControl.disabled, false);
  assert.equal(uncertain.submissionNotice.reconnect, true);

  const answer = { transcriptId: 'transcript', index: 1 };
  const cancelled = projectSubmission({ ...state, answerAvailability: 'pending', submission: { ...state.submission, remote: { ...state.submission.remote, answer, result: { status: 'cancelled' } } } });
  assert.match(cancelled.submissionNotice.message, /回答已保留，正文待同步.*处理已取消/);
  assert.equal(cancelled.submissionControl, undefined);
  assert.equal(cancelled.submissionNotice.reconnect, false);

  const completed = projectSubmission({ ...state, submission: { ...state.submission, remote: { ...state.submission.remote, result: { status: 'completed' } } } });
  assert.match(completed.submissionNotice.message, /处理已完成.*没有改变/);
  assert.equal(completed.submissionControl, undefined);
});

test('submission presentation distinguishes completed work from body synchronization and keeps cached answers available', () => {
  const initial = client({ conversation: transport() }).getSnapshot();
  const state = {
    ...initial,
    submission: {
      feedback: { status: 'ended' },
      remote: submissionSnapshot('submission', { answer: { transcriptId: 'transcript', index: 1 }, result: { status: 'completed' } }),
    },
  };
  for (const answerAvailability of ['unloaded', 'pending']) {
    const projected = projectSubmission({ ...state, answerAvailability });
    assert.match(projected.progress, /处理已完成.*正文待同步/);
    assert.equal(projected.submissionNotice, undefined);
  }
  const cached = projectSubmission({ ...state, answerAvailability: 'available', transcriptId: 'transcript', transcripts: new Map([['transcript', { status: 'disconnected', error: new Error('连接断开') }]]) });
  assert.equal(cached.progress, '');
  assert.equal(cached.submissionNotice, undefined, 'a disconnected sync does not make a cached answer pending');
  const failed = projectSubmission({ ...state, answerAvailability: 'pending', submission: { ...state.submission, remote: { ...state.submission.remote, result: { status: 'failed', error: { message: '记忆处理失败' } } } } });
  assert.match(failed.submissionNotice.message, /回答已保留，正文待同步.*记忆处理失败/);
});
