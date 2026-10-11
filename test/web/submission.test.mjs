import test from 'node:test';
import assert from 'node:assert/strict';
import { installFrames } from './frames.mjs';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { projectSubmission } from '../../apps/observer/.test-dist/binding/submission.js';
import { client, transport, submissionSnapshot } from '../client/fixtures.mjs';

const responseOf = (data) => data.conversation.findLast((item) => item.kind === 'response');

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
  assert.equal(responseOf(pending).body.message.content, '正式回答');
  assert.equal(pending.busy, true);
  assert.match(responseOf(pending).notice.message, /结果待确认/);
  assert.equal(responseOf(pending).notice.reconnect, true);
  assert.equal('release' in responseOf(pending).notice, false);
  assert.equal(pending.submissionControl.label, '停止当前回答');
  assert.equal(app.store.getState().draft, '');
  await app.commands.reconnectSubmission();
  await frames.flush();
  assert.equal(posts, 1);
  assert.equal(follows, 1);
  assert.equal(app.store.getState().data.busy, false);
  assert.equal(responseOf(app.store.getState().data).notice, undefined);
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
  assert.equal(app.store.getState().data.conversation.find((item) => item.kind === 'pending-input').label, '提交待确认');
  app.store.getState().setDraft('后续消息');
  await app.commands.submit();
  await frames.flush();
  assert.equal(calls, 1);
  assert.equal(app.store.getState().data.busy, true);
  assert.match(responseOf(app.store.getState().data).notice.message, /结果待确认/);
  assert.equal(app.store.getState().data.queue.waiting[0].pending, '后续消息');
  assert.equal(app.store.getState().draft, '');
  assert.equal('release' in responseOf(app.store.getState().data).notice, false);
  await app.commands.cancelSubmission(app.store.getState().data.queue.waiting[0].id);
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
    assert.equal(responseOf(data).notice?.reconnect, scenario === 'failed' ? undefined : scenario === 'incomplete');
    assert.equal('release' in (responseOf(data).notice ?? {}), false);
    if (scenario === 'rejected') {
      assert.match(responseOf(data).notice.message, /消息未被接纳/);
      assert.equal(data.messageCount, 0);
      assert.equal(data.conversation.length, 2);
      assert.equal(data.conversation[0].kind, 'pending-input');
      assert.equal(data.conversation[0].content, '问题', 'a rejected input remains readable outside the formal transcript');
      assert.equal(app.store.getState().draft, '');
    } else {
      assert.equal(responseOf(data).body.message.content, '已落实回答');
      if (scenario === 'failed') {
        assert.equal(responseOf(data).notice, undefined, 'postprocessing failure does not invalidate the delivered answer');
        assert.equal(runtime.getSnapshot().submission.remote.result.error.message, '记忆处理失败', 'runtime retains the real diagnosis');
      } else {
        assert.match(responseOf(data).notice.message, /进展无法完整确认/);
        assert.equal(responseOf(data).notice.input, undefined, 'already committed input is not repeated in the notice');
      }
    }
    disconnect();
  }
});

test('cancellation presentation keeps control acknowledgement separate from actual termination', () => {
  const initial = client({ conversation: transport() }).getSnapshot();
  const state = { ...initial, busy: true, submission: { id: 'current', queueId: 'local-current', pending: '问题', feedback: { status: 'following' }, cancellation: { status: 'acknowledged' }, remote: submissionSnapshot('current', { revision: 2, cancelRequested: true }) } };
  const pending = projectSubmission(state);
  assert.match(pending.submissionNotice.message, /服务已接收取消请求.*实际结束/);
  assert.equal(pending.submissionControl.id, 'current');
  assert.equal(pending.submissionControl.disabled, true);
  assert.equal(pending.progress, '等待取消结果…');

  const uncertain = projectSubmission({ ...state, submission: { ...state.submission, remote: undefined, feedback: { status: 'interrupted', error: new Error('断流') }, cancellation: { status: 'uncertain', error: new Error('响应丢失') } } });
  assert.match(uncertain.submissionNotice.message, /是否送达尚未确认.*响应丢失/);
  assert.equal(uncertain.submissionControl.label, '重试停止当前回答');
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
  assert.equal(failed.submissionNotice, undefined);
  assert.match(failed.progress, /回答已生成.*正文待同步/);
});

test('answer presentation follows committed output, not the internal failure code or activity availability', () => {
  const initial = client({ conversation: transport() }).getSnapshot();
  for (const code of ['MEMORY_SOURCE', 'UNKNOWN_INTERNAL_FAILURE']) {
    const result = { status: 'failed', error: { code, message: '变更后的依据必须包含本次变更依据。' } };
    const submission = { id: 'current', queueId: 'current', feedback: { status: 'ended' }, remote: submissionSnapshot('current', { answer: { transcriptId: 'transcript', index: 1 }, result }) };
    const answered = projectSubmission({ ...initial, submission, answerAvailability: 'available' });
    assert.equal(answered.progress, '');
    assert.equal(answered.submissionNotice, undefined);
    assert.equal(submission.remote.result, result, 'presentation never rewrites service facts');
    const unanswered = projectSubmission({ ...initial, submission: { ...submission, remote: { ...submission.remote, answer: undefined } } });
    assert.match(unanswered.submissionNotice.message, /未能完成回答/);
    assert.doesNotMatch(unanswered.submissionNotice.message, /依据|MEMORY|内部/);
    assert.equal(unanswered.submissionNotice.reconnect, false, 'known failed work is not an unknown connection');
  }
});
