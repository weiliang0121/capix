import test from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../../apps/observer/.test-dist/binding/application.js';
import { client, transport, submissionSnapshot } from '../client/fixtures.mjs';

test('application keeps a committed answer across disconnect and reconnects feedback without resubmitting', async () => {
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
  const pending = app.store.getState().data;
  assert.equal(pending.conversation.at(-1).message.content, '正式回答');
  assert.equal(pending.busy, true);
  assert.match(pending.submissionNotice.message, /结果待确认/);
  assert.equal(pending.submissionNotice.reconnect, true);
  assert.equal(pending.submissionNotice.release, true);
  assert.equal(app.store.getState().draft, '');
  await app.commands.reconnectSubmission();
  assert.equal(posts, 1);
  assert.equal(follows, 1);
  assert.equal(app.store.getState().data.busy, false);
  assert.equal(app.store.getState().data.submissionNotice, undefined);
  assert.equal(app.store.getState().data.conversation.length, 2);
  disconnect();
});

test('ending unknown local tracking preserves edits and explicitly does not claim server cancellation', async () => {
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
  assert.equal(app.store.getState().draft, '未确认输入');
  assert.equal(app.store.getState().data.busy, true);
  assert.equal(app.store.getState().data.pendingLabel, '提交待确认');
  app.commands.releaseSubmission();
  assert.equal(calls, 1);
  assert.equal(app.store.getState().data.busy, false);
  assert.equal(app.store.getState().data.submissionNotice, undefined);
  assert.equal(app.store.getState().draft, '未确认输入');
  assert.match(app.store.getState().notice, /未被取消/);
  disconnect();
});

test('application distinguishes known rejection, failed postprocessing and incomplete projection', async () => {
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
    const data = app.store.getState().data;
    assert.equal(data.busy, scenario === 'incomplete');
    assert.equal(data.submissionNotice.reconnect, scenario === 'incomplete');
    assert.equal(data.submissionNotice.release, scenario === 'incomplete');
    if (scenario === 'rejected') {
      assert.match(data.submissionNotice.message, /提交被拒绝/);
      assert.equal(data.conversation.length, 0);
      assert.equal(data.pending, '');
      assert.equal(app.store.getState().draft, '问题');
    } else {
      assert.equal(data.conversation.at(-1).message.content, '已落实回答');
      assert.match(data.submissionNotice.message, scenario === 'failed' ? /回答已保留.*记忆处理失败/ : /进展无法完整确认/);
    }
    disconnect();
  }
});
