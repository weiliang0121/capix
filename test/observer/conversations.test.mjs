import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { ObserverConversations, createObserverServer } from '@capix/observer-service';
import { RuntimeError } from '@capix/server-runtime';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
async function fixture(t) {
  let constructions = 0;
  let calls = 0;
  const host = new ObserverConversations(() => {
    constructions += 1;
    return {
      async invoke(_request, purpose) {
        calls += 1;
        return { id: 'fixture', model: 'fixture', content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'answer' ? { kind: 'answer', content: '回复' } : { memories: [] }), finishReason: 'stop', usage: null };
      },
    };
  });
  const server = createObserverServer({ conversations: host, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    host.close();
  });
  const request = (path, body) => fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const get = async (path) => {
    const value = await (await request(path)).json();
    if (path.startsWith('/api/submissions/') && !value.code) {
      assert.equal(value.type, 'baseline');
      return value.submission;
    }
    return value;
  };
  const run = async (conversationId, submissionId, content) => submissionSnapshots((await (await request('/api/run', { conversationId, submissionId, input: { messages: [{ role: 'user', content }] } })).text()).trim().split('\n').map(JSON.parse)).at(-1);
  return {
    host,
    request,
    get,
    run,
    get constructions() {
      return constructions;
    },
    get calls() {
      return calls;
    },
  };
}

test('catalog and content browsing are passive; explicit targets isolate two clients without observation', async (t) => {
  const service = await fixture(t);
  const catalog = await service.get('/api/conversations');
  const first = catalog.conversations[0];
  const secondResponse = await service.request('/api/conversations', {});
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json();
  for (const descriptor of [first, second]) {
    assert.deepEqual(await service.get('/api/conversations/' + descriptor.id), descriptor);
    assert.equal((await service.get('/api/conversation/admission?conversationId=' + descriptor.id)).status, 'ready');
    assert.deepEqual(await service.get(`/api/conversations/${descriptor.id}/submission`), { conversationId: descriptor.id, transcriptId: descriptor.transcriptId });
    assert.equal((await service.get('/api/transcript?id=' + descriptor.transcriptId)).messages.length, 0);
    assert.equal(service.host.peek(descriptor.id), undefined, 'reading content does not construct runtime or recorder');
  }
  assert.equal(service.constructions, 0);
  assert.equal(service.calls, 0);
  assert.equal((await service.request('/api/conversation/admission')).status, 400);
  assert.equal((await service.request('/api/transcript')).status, 400);
  const missing = await service.request('/api/conversations/unknown/submission');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'CONVERSATION_NOT_FOUND');
  const left = await service.run(first.id, 'left-submission', '只属于第一段');
  const right = await service.run(second.id, 'right-submission', '只属于第二段');
  assert.equal(left.result.status, 'completed');
  assert.equal(right.result.status, 'completed');
  assert.equal((await service.get(`/api/conversations/${first.id}/submission`)).submission, undefined, 'finished submissions are retained by ID, not advertised as current work');
  assert.equal(left.conversationId, first.id);
  assert.equal(right.conversationId, second.id);
  assert.equal(left.input.transcriptId, first.transcriptId);
  assert.equal(right.input.transcriptId, second.transcriptId);
  const leftRead = await service.get('/api/transcript?id=' + first.transcriptId);
  const rightRead = await service.get('/api/transcript?id=' + second.transcriptId);
  assert.deepEqual(
    leftRead.messages.map((item) => item.content),
    ['只属于第一段', '回复'],
  );
  assert.deepEqual(
    rightRead.messages.map((item) => item.content),
    ['只属于第二段', '回复'],
  );
  assert.equal((await service.get('/api/submissions/left-submission')).conversationId, first.id);
  const leftOverview = await service.get('/api/executions?conversationId=' + first.id);
  assert.equal((await service.request('/api/execution?conversationId=' + second.id + '&id=' + leftOverview.executions[0].id)).status, 404);
  assert.equal((await service.get('/api/conversations/' + first.id)).title, '只属于第一段');
  assert.equal(service.constructions, 1, 'provider is shared; content bindings are separate');
});

test('failed lazy assembly has terminal feedback and does not strand an admitted submission', async (t) => {
  const service = await fixture(t);
  const id = service.host.list().defaultConversationId;
  const original = service.host.open.bind(service.host);
  t.mock.method(service.host, 'open', () => {
    throw new RuntimeError('ASSEMBLY_FAILED', 'fixture assembly failure');
  });
  const failed = await service.run(id, 'failed-assembly', '未运行');
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.result.error.code, 'ASSEMBLY_FAILED');
  assert.equal(failed.input, undefined);
  assert.equal((await service.get('/api/submissions/failed-assembly')).result.status, 'failed');
  assert.equal(service.calls, 0);
  t.mock.method(service.host, 'open', original);
  assert.equal((await service.get('/api/conversation/admission?conversationId=' + id)).status, 'ready');
  assert.equal((await service.run(id, 'after-failure', '现在运行')).result.status, 'completed');
});

test('repeated lazy assembly failure releases its record listener while shared content synchronization stays live', (t) => {
  const host = new ObserverConversations(() => assert.fail('failed assembly must not initialize the model'), [], { maxDecisionSteps: 17 });
  t.after(() => host.close());
  const id = host.list().defaultConversationId;
  const content = host.content(id);
  const original = content.consumer.subscribe.bind(content.consumer);
  let attached = 0;
  let detached = 0;
  t.mock.method(content.consumer, 'subscribe', (listener) => {
    attached += 1;
    const unsubscribe = original(listener);
    return () => {
      detached += 1;
      unsubscribe();
    };
  });
  const frames = [];
  content.consumer.flush();
  const disconnect = content.transcripts.connect((frame) => frames.push(frame));
  t.after(disconnect);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.throws(() => host.open(id), /Decision steps/);
    assert.equal(host.peek(id), undefined);
    assert.equal(attached, attempt + 1);
    assert.equal(detached, attached, 'each failed recording source releases exactly its own subscription');
    content.transcript.append({ role: 'user', content: `失败后消息 ${attempt}` });
    content.consumer.flush();
    assert.equal(frames.at(-1).type, 'delta');
    assert.equal(frames.at(-1).event.change.messages[0].content, `失败后消息 ${attempt}`);
  }
  assert.equal(content.transcript.length, 3);
  assert.equal(frames.length, 4, 'the established transcript connection survives all assembly failures');
});
import { submissionSnapshots } from '../fixtures/submissions.mjs';
