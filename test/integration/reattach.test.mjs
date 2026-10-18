import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObserverConversations, SqliteObserverStore, createObserverServer } from '@capix/observer-service';
import { ClientRuntime, SubmissionUnavailableError } from '@capix/client-runtime';
import { ConversationHttpTransport } from '@capix/client-http';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 5000 };
const output = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const input = { messages: [{ role: 'user', content: '接回原提交' }] };
const gate = () => Promise.withResolvers();
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await tick();
  assert.ok(check(), 'reattached client did not reach its expected boundary');
}

function trackingStore() {
  let value;
  return {
    load: () => value,
    save(locator) {
      value = { ...locator };
    },
  };
}

async function start(t, provider, options = {}) {
  const conversations = new ObserverConversations(provider, [], options.persistence ? { persistence: options.persistence } : {});
  const server = createObserverServer({ conversations, settings, configured: true });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const requests = [];
  const clients = [];
  let closed = false;
  const host = {
    conversations,
    requests,
    transport: new ConversationHttpTransport(base),
    async client(tracking) {
      const transport = new ConversationHttpTransport(base, (url, init) => {
        requests.push({ path: new URL(url).pathname, method: init?.method ?? 'GET' });
        return fetch(url, init);
      });
      const runtime = new ClientRuntime({ conversation: transport, transcripts: transport, tracking });
      clients.push(runtime);
      await runtime.initialize();
      return runtime;
    },
    async close() {
      if (closed) return;
      closed = true;
      options.release?.();
      for (const runtime of clients) {
        runtime.stopFollowing();
        runtime.stopTranscript();
      }
      await until(() => !conversations.active);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      conversations.close();
    },
  };
  t.after(() => host.close());
  return host;
}

test('a replacement client follows the original HTTP submission, receives its current preview and can cancel after the formal answer', { timeout: 10000 }, async (t) => {
  const answer = gate();
  const memory = gate();
  const calls = [];
  const host = await start(
    t,
    {
      async invoke(_request, purpose, signal, progress) {
        calls.push(purpose);
        if (purpose === 'selection') return output({ historyIndexes: [] });
        if (purpose === 'memory') {
          await Promise.race([
            memory.promise,
            new Promise((_resolve, reject) => {
              if (signal.aborted) reject(signal.reason);
              else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            }),
          ]);
          return output({ memories: [] });
        }
        progress.publish({ text: '{"kind":"answer","content":"正在回答' });
        await answer.promise;
        progress.publish({ text: '，正式结果"}' });
        return output({ kind: 'answer', content: '正在回答，正式结果' });
      },
    },
    {
      release: () => {
        answer.resolve();
        memory.resolve();
      },
    },
  );
  const tracking = trackingStore();
  const first = await host.client(tracking);
  const conversation = await first.createConversation();
  assert.notEqual(conversation.id, host.conversations.list().defaultConversationId, 'the locator must restore a non-default conversation');
  const sending = first.submit(input);
  void sending.catch(() => undefined);
  await until(() => first.getSnapshot().submission?.preview?.snapshot?.text === '正在回答');
  const id = first.getSnapshot().submission.id;
  assert.deepEqual(tracking.load(), { conversationId: conversation.id, transcriptId: conversation.transcriptId, submissionId: id });
  first.stopFollowing();
  first.stopTranscript();
  await sending;

  const second = await host.client(tracking);
  await until(() => second.getSnapshot().submission?.feedback.status === 'following');
  assert.equal(second.getSnapshot().conversation.id, conversation.id);
  assert.equal(second.getSnapshot().submission.id, id);
  assert.equal(second.getSnapshot().submission.preview.snapshot.text, '正在回答');
  assert.equal(second.getSnapshot().submission.remote.result, undefined);
  assert.ok(second.getSnapshot().submission.remote.activities.calls.some((call) => call.status === 'running'));
  assert.deepEqual(second.getSnapshot().messages, input.messages);
  answer.resolve();
  await until(() => second.getSnapshot().messages.length === 2 && calls.includes('memory'));
  assert.equal(second.getSnapshot().submission.remote.result, undefined);
  await second.cancelSubmission(id);
  await until(() => second.getSnapshot().submission?.remote?.result?.status === 'cancelled');
  assert.equal(second.getSnapshot().submission.remote.cancelRequested, true);
  assert.deepEqual(
    second.getSnapshot().messages.map((message) => message.content),
    ['接回原提交', '正在回答，正式结果'],
  );
  assert.deepEqual(calls, ['answer', 'memory']);
  assert.equal(host.requests.filter((request) => request.path === '/api/run').length, 1);
  assert.ok(host.requests.some((request) => request.path === `/api/submissions/${id}/follow` && request.method === 'GET'));
  assert.ok(host.requests.some((request) => request.path === `/api/submissions/${id}/cancel` && request.method === 'POST'));
  assert.equal(tracking.load().submissionId, undefined, 'only the confirmed terminal result clears the stored submission');
});

test('a stored submission finished while detached is read by its original ID even though active discovery is empty', { timeout: 10000 }, async (t) => {
  const answer = gate();
  const calls = [];
  const host = await start(
    t,
    {
      async invoke(_request, purpose) {
        calls.push(purpose);
        if (purpose === 'selection') return output({ historyIndexes: [] });
        if (purpose === 'memory') return output({ memories: [] });
        await answer.promise;
        return output({ kind: 'answer', content: '离线时已完成' });
      },
    },
    { release: () => answer.resolve() },
  );
  const tracking = trackingStore();
  const first = await host.client(tracking);
  const sending = first.submit(input);
  void sending.catch(() => undefined);
  await until(() => calls.includes('answer') && first.getSnapshot().submission?.remote?.input);
  const id = first.getSnapshot().submission.id;
  const conversationId = first.getSnapshot().conversation.id;
  first.stopFollowing();
  first.stopTranscript();
  await sending;
  answer.resolve();
  await until(() => !host.conversations.active);
  assert.equal((await host.transport.activeSubmission(conversationId)).submission, undefined);
  assert.equal(tracking.load().submissionId, id);

  const second = await host.client(tracking);
  assert.equal(second.getSnapshot().submission.id, id);
  assert.equal(second.getSnapshot().submission.remote.result.status, 'completed');
  assert.deepEqual(
    second.getSnapshot().messages.map((message) => message.content),
    ['接回原提交', '离线时已完成'],
  );
  assert.deepEqual(calls, ['answer', 'memory']);
  assert.equal(host.requests.filter((request) => request.path === '/api/run').length, 1);
  assert.equal(host.requests.filter((request) => request.path === `/api/submissions/${id}/follow`).length, 0, 'a known terminal baseline needs no live follow');
  assert.equal(tracking.load().submissionId, undefined);
});

test('service reconstruction preserves content but an unavailable stored submission stays unknown and is never posted again', { timeout: 10000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capix-reattach-'));
  const path = join(directory, 'observer.sqlite');
  const answer = gate();
  const firstHost = await start(
    t,
    {
      async invoke(_request, purpose) {
        if (purpose === 'selection') return output({ historyIndexes: [] });
        if (purpose === 'memory') return output({ memories: [] });
        await answer.promise;
        return output({ kind: 'answer', content: '保存的回答' });
      },
    },
    { persistence: SqliteObserverStore.open(path), release: () => answer.resolve() },
  );
  const tracking = trackingStore();
  const first = await firstHost.client(tracking);
  const sending = first.submit(input);
  void sending.catch(() => undefined);
  await until(() => first.getSnapshot().submission?.remote?.input);
  const id = first.getSnapshot().submission.id;
  first.stopFollowing();
  first.stopTranscript();
  await sending;
  answer.resolve();
  await until(() => !firstHost.conversations.active);
  await firstHost.close();
  const secondHost = await start(t, { invoke: () => assert.fail('reattachment must never issue a model request') }, { persistence: SqliteObserverStore.open(path) });
  t.after(async () => {
    await secondHost.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const second = await secondHost.client(tracking);
  assert.equal(second.getSnapshot().submission.id, id);
  assert.equal(second.getSnapshot().submission.remote, undefined);
  assert.equal(second.getSnapshot().submission.feedback.status, 'unavailable');
  assert.ok(second.getSnapshot().submission.feedback.error instanceof SubmissionUnavailableError);
  assert.deepEqual(
    second.getSnapshot().messages.map((message) => message.content),
    ['接回原提交', '保存的回答'],
  );
  assert.equal(second.getSnapshot().canSwitchConversation, false);
  assert.equal(tracking.load().submissionId, id, 'absence cannot be interpreted as completion');
  await assert.rejects(second.submit(input), /尚未确认结束/);
  assert.equal(secondHost.requests.filter((request) => request.path === '/api/run').length, 0);
  assert.equal(secondHost.requests.filter((request) => request.path === `/api/submissions/${id}`).length, 1);
});
