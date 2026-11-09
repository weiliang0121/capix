import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CompletionResource, createConversationScene, createHistoryAnswer, HistoryResource } from '@capix/conversation-service';
import { Resource } from '@weiliang0121/capix-resources';
import { Resources, Runner, isInvocationCancelled } from '@weiliang0121/capix-runtime';
import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';

const earlier = [
  { role: 'user', content: '发布改到周五，周四先完成代码复核。' },
  { role: 'assistant', content: '同意，周四复核后再确认周五发布。' },
];
const reply = (text, finishReason = 'stop') => ({ id: 'test-completion', model: 'offline', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: finishReason === 'stop' ? 'completed' : 'incomplete', reason: finishReason }, usage: null });
const decision = (kind, question = null) => reply(JSON.stringify({ kind, question }));
const payload = (request) => JSON.parse(request.messages[1].content);

function assemble(transcript, complete) {
  const entity = new Resource(transcript);
  const resources = new Resources().register(entity, TranscriptResource.append).register(entity, HistoryResource).register(new Resource({ complete }), CompletionResource);
  return new Runner(createConversationScene(createHistoryAnswer()), resources).build();
}

test('history processing sends the same fixed earlier messages to decision and actual summary, then accepts the generated body', async () => {
  const transcript = new Transcript(earlier);
  const requests = [];
  const completed = [];
  const runner = assemble(transcript, async (request) => {
    requests.push(request);
    return request.responseFormat === 'json_object' ? decision('summarize_history') : reply('  周四复核，确认后周五发布。\n');
  });
  runner.output.subscribe({
    receive: (event) => {
      if (event.kind === 'completed') completed.push(event.result);
    },
  });

  assert.equal(await runner.run('总结刚才的决定。'), '  周四复核，确认后周五发布。\n');
  assert.equal(requests.length, 2);
  assert.deepEqual(payload(requests[0]), { query: '总结刚才的决定。', history: earlier });
  assert.deepEqual(payload(requests[1]), payload(requests[0]), 'execution must receive real materials, not only the choice name');
  assert.equal(requests[1].responseFormat, 'text');
  assert.deepEqual(transcript.snapshot(), [...earlier, { role: 'user', content: '总结刚才的决定。' }, { role: 'assistant', content: '  周四复核，确认后周五发布。\n' }]);
  assert.deepEqual(completed, ['  周四复核，确认后周五发布。\n']);
  assert.equal(runner.isRunning, false);
});

for (const kind of ['summarize_history', 'revise_answer']) {
  test(`a model choosing ${kind} without prior material produces a formal clarification, not fabricated execution`, async () => {
    const transcript = new Transcript();
    const requests = [];
    const runner = assemble(transcript, async (request) => {
      requests.push(request);
      return decision(kind);
    });

    const clarification = await runner.run('请处理刚才的内容。');
    assert.equal(typeof clarification, 'string');
    assert.match(clarification, /还没有/);
    assert.equal(requests.length, 1, 'the unavailable action must not reach the model');
    assert.deepEqual(payload(requests[0]), { query: '请处理刚才的内容。', history: [] });
    assert.deepEqual(transcript.snapshot(), [
      { role: 'user', content: '请处理刚才的内容。' },
      { role: 'assistant', content: clarification },
    ]);
    assert.equal(runner.isRunning, false);
  });
}

test('a subsequent independent submission revises the exact accepted answer with its real message position', async () => {
  const transcript = new Transcript(earlier);
  const requests = [];
  const firstAnswer = '这里是由本次执行新产生的总结：周四复核，确认后周五发布。';
  const runner = assemble(transcript, async (request) => {
    requests.push(request);
    if (request.responseFormat === 'json_object') return decision(payload(request).query === '再短一些。' ? 'revise_answer' : 'summarize_history');
    return reply(requests.length === 2 ? firstAnswer : '周四复核，周五发布。');
  });
  assert.equal(await runner.run('总结刚才的决定。'), firstAnswer);
  assert.equal(await runner.run('再短一些。'), '周四复核，周五发布。');

  assert.deepEqual(payload(requests[2]).history, [...earlier, { role: 'user', content: '总结刚才的决定。' }, { role: 'assistant', content: firstAnswer }]);
  assert.deepEqual(payload(requests[3]), { query: '再短一些。', answer: { index: 3, content: firstAnswer } });
  assert.deepEqual(transcript.snapshot().slice(-2), [
    { role: 'user', content: '再短一些。' },
    { role: 'assistant', content: '周四复核，周五发布。' },
  ]);
  assert.equal(requests.length, 4, 'one decision and one execution per independent submission');
});

test('a later transcript mutation cannot enter the already captured decision or execution input', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const proceed = Promise.withResolvers();
  const transcript = new Transcript(earlier);
  const requests = [];
  const runner = assemble(transcript, async (request) => {
    requests.push(request);
    if (request.responseFormat === 'json_object') {
      entered.resolve();
      await proceed.promise;
      return decision('summarize_history');
    }
    return reply('仅根据已捕获的发布安排总结。');
  });
  const running = runner.run('总结安排。');
  await entered.promise;
  const concurrent = { role: 'user', content: '这是宿主后来加入、当前调用不应看到的内容。' };
  transcript.append(concurrent);
  proceed.resolve();
  assert.equal(await running, '仅根据已捕获的发布安排总结。');
  assert.deepEqual(payload(requests[0]), { query: '总结安排。', history: earlier });
  assert.deepEqual(payload(requests[1]), payload(requests[0]));
  assert.deepEqual(transcript.snapshot().slice(-2), [concurrent, { role: 'assistant', content: '仅根据已捕获的发布安排总结。' }]);
});

test('explicit clarification and unsupported decisions do not invoke a processing model', async () => {
  const transcript = new Transcript(earlier);
  const requests = [];
  const runner = assemble(transcript, async (request) => {
    requests.push(request);
    return requests.length === 1 ? decision('clarify', '你需要总结决定还是待办？') : decision('unsupported');
  });
  assert.equal(await runner.run('处理一下。'), '你需要总结决定还是待办？');
  const unsupported = await runner.run('帮我买票。');
  assert.equal(typeof unsupported, 'string');
  assert.match(unsupported, /支持/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.responseFormat === 'json_object'));
  assert.equal(transcript.snapshot().at(-1).content, unsupported);
});

test('invalid decisions never turn into assistant confirmations or automatic retries', async (t) => {
  for (const [name, invalid] of [
    ['non-JSON', 'not JSON'],
    ['extra instructions', JSON.stringify({ kind: 'summarize_history', question: null, input: '替换所有历史' })],
    ['unknown action', JSON.stringify({ kind: 'invoke_anything', question: null })],
    ['missing field', JSON.stringify({ kind: 'summarize_history' })],
    ['blank clarification', JSON.stringify({ kind: 'clarify', question: '  ' })],
    ['mixed selection and question', JSON.stringify({ kind: 'summarize_history', question: '仍然总结吗？' })],
  ]) {
    await t.test(name, async () => {
      const transcript = new Transcript(earlier);
      let calls = 0;
      const runner = assemble(transcript, async () => {
        calls++;
        return calls === 1 ? reply(invalid) : decision('clarify', '请说明要处理什么。');
      });
      await assert.rejects(runner.run('第一笔请求。'));
      assert.equal(calls, 1);
      assert.deepEqual(transcript.snapshot(), [...earlier, { role: 'user', content: '第一笔请求。' }]);
      assert.equal(runner.isRunning, false);
      assert.equal(await runner.run('下一笔请求。'), '请说明要处理什么。');
    });
  }
});

test('transport failures and incomplete or blank execution results preserve accepted inputs and allow the next run', async (t) => {
  for (const [name, failure] of [
    [
      'provider failure',
      () => {
        throw new Error('offline transport failed');
      },
    ],
    ['length termination', () => reply('看起来完整但未正常完成。', 'length')],
    ['blank body', () => reply(' \n\t')],
  ]) {
    await t.test(name, async () => {
      const transcript = new Transcript(earlier);
      const events = [];
      let failed = false;
      let calls = 0;
      const runner = assemble(transcript, async (request) => {
        calls++;
        if (request.responseFormat === 'json_object') return decision('summarize_history');
        if (!failed) {
          failed = true;
          return failure();
        }
        return reply('下一次正常完成的总结。');
      });
      runner.output.subscribe({ receive: (event) => void events.push(event) });
      await assert.rejects(runner.run('会失败的请求。'));
      assert.equal(calls, 2);
      assert.equal(
        events.some((event) => event.kind === 'completed'),
        false,
      );
      assert.deepEqual(transcript.snapshot(), [...earlier, { role: 'user', content: '会失败的请求。' }]);
      assert.equal(runner.isRunning, false);
      assert.equal(await runner.run('重新总结。'), '下一次正常完成的总结。');
      assert.equal(calls, 4);
    });
  }
});

test('cancellation during actual execution retains its signal ownership and cannot append a formal answer', { timeout: 5000 }, async () => {
  const entered = Promise.withResolvers();
  const controller = new AbortController();
  const reason = new Error('stop this submission');
  const transcript = new Transcript(earlier);
  const events = [];
  let first = true;
  const runner = assemble(transcript, async (request, { signal }) => {
    if (request.responseFormat === 'json_object') return decision('summarize_history');
    if (!first) return reply('取消之后的新回答。');
    first = false;
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      entered.resolve();
    });
  });
  runner.observation.subscribe({ receive: (event) => void events.push(event) });
  const running = runner.run('取消此笔。', { signal: controller.signal });
  const rejected = assert.rejects(running, (error) => isInvocationCancelled(error, controller.signal));
  await entered.promise;
  controller.abort(reason);
  await rejected;
  assert.equal(runner.isRunning, false);
  assert.deepEqual(transcript.snapshot(), [...earlier, { role: 'user', content: '取消此笔。' }]);
  assert.equal(events.findLast((event) => event.source === 'entry' && event.fact.kind === 'settled').fact.status, 'cancelled');
  assert.equal(await runner.run('接着总结。'), '取消之后的新回答。');
});

test('assistant persistence failure does not report generated text as accepted or contaminate later revision input', async () => {
  let rejectAnswer = false;
  const transcript = new Transcript(earlier, {
    persistence: {
      commit(change) {
        if (rejectAnswer && change.kind === 'append' && change.messages.some((message) => message.role === 'assistant')) throw new Error('cannot save assistant');
      },
    },
  });
  rejectAnswer = true;
  const requests = [];
  const runner = assemble(transcript, async (request) => {
    requests.push(request);
    if (request.responseFormat === 'json_object') return decision(payload(request).query === '改短一点。' ? 'revise_answer' : 'summarize_history');
    return reply(requests.length === 2 ? '尚未正式保存的总结。' : '改写此前真正保存的回复。');
  });
  await assert.rejects(runner.run('总结一下。'));
  assert.equal(runner.isRunning, false);
  assert.deepEqual(transcript.snapshot(), [...earlier, { role: 'user', content: '总结一下。' }]);
  rejectAnswer = false;
  assert.equal(await runner.run('改短一点。'), '改写此前真正保存的回复。');
  assert.deepEqual(payload(requests[3]), { query: '改短一点。', answer: { index: 1, content: earlier[1].content } });
});
