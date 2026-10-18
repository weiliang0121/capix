import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObserverConversations, SqliteObserverStore, createObserverServer } from '@capix/observer-service';
import { ClientRuntime } from '@capix/client-runtime';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix/client-http';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 2000 };
const output = (value) => ({ id: 'fixture', model: 'fixture', content: JSON.stringify(value), finishReason: 'stop', usage: null });
const request = (content) => ({ messages: [{ role: 'user', content }] });
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), 'conversation state did not reach its expected boundary');
}

test('two clients keep explicit conversation targets, isolated content and records across switching and restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capix-conversations-integration-'));
  const path = join(directory, 'observer.sqlite');
  const hosts = [];
  t.after(async () => {
    for (const host of hosts) await host.close();
    rmSync(directory, { recursive: true, force: true });
  });

  async function start() {
    const calls = [];
    const conversations = new ObserverConversations(
      {
        async invoke(modelRequest, purpose) {
          const input = JSON.parse(modelRequest.messages[1].content);
          calls.push({ purpose, input });
          if (purpose === 'selection') return output({ historyIndexes: [] });
          if (purpose === 'memory') {
            if (input.memories.length) return output({ memories: [] });
            const content = input.messages.find((message) => message.index === input.currentIndexes[0]).content;
            return output({ memories: [{ action: 'create', memoryId: null, change: content, sourceIndexes: input.currentIndexes, result: { topic: content, content, sourceIndexes: input.currentIndexes } }] });
          }
          return output({ kind: 'answer', content: `answer:${input.message.content}` });
        },
      },
      [],
      { persistence: SqliteObserverStore.open(path) },
    );
    const server = createObserverServer({ conversations, settings, configured: true });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const clients = [];
    let closed = false;
    const host = {
      calls,
      conversations,
      base,
      async client(observe = false) {
        const transport = new ConversationHttpTransport(base);
        const observation = new ObservationHttpTransport(base);
        const runtime = new ClientRuntime({ conversation: transport, transcripts: transport, observation });
        const stop = observe ? runtime.startObservation() : () => undefined;
        clients.push({ runtime, stop });
        await runtime.initialize();
        return { runtime, transport, observation };
      },
      async close() {
        if (closed) return;
        closed = true;
        for (const { runtime, stop } of clients) {
          stop();
          runtime.stopFollowing();
          runtime.stopTranscript();
        }
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        conversations.close();
      },
    };
    hosts.push(host);
    return host;
  }

  const first = await start();
  const a = await first.client(true);
  const b = await first.client();
  const alpha = a.runtime.getSnapshot().conversation;
  assert.equal(b.runtime.getSnapshot().conversation.id, alpha.id);
  assert.equal(first.calls.length, 0, 'opening clients and observation never invokes the model');
  await a.runtime.submit(request('alpha'));
  await until(() => a.runtime.getSnapshot().messages.length === 2 && a.runtime.getSnapshot().observation.records.size === 1);
  const alphaExecution = [...a.runtime.getSnapshot().observation.records.keys()][0];
  const beta = await b.runtime.createConversation();
  assert.notEqual(beta.id, alpha.id);
  assert.notEqual(beta.transcriptId, alpha.transcriptId);
  assert.equal(a.runtime.getSnapshot().conversation.id, alpha.id, 'another client cannot change this client target');
  await b.runtime.submit(request('beta'));
  await until(() => b.runtime.getSnapshot().messages.length === 2);
  assert.equal(b.runtime.getSnapshot().submission.remote.conversationId, beta.id);
  assert.equal(b.runtime.getSnapshot().observation.enabled, false, 'conversation works with observation disabled');
  assert.equal(b.runtime.getSnapshot().observation.records.size, 0);
  assert.deepEqual(
    first.conversations
      .content(alpha.id)
      .memories.values()
      .map((memory) => memory.content),
    ['alpha'],
  );
  assert.deepEqual(
    first.conversations
      .content(beta.id)
      .memories.values()
      .map((memory) => memory.content),
    ['beta'],
  );
  await assert.rejects(b.observation.execution(beta.id, alphaExecution), 'record queries must not cross the requested conversation');

  await a.runtime.openConversation(beta.id);
  await until(() => a.runtime.getSnapshot().observation.overview?.executions.length === 1);
  assert.deepEqual(
    a.runtime.getSnapshot().messages.map((message) => message.content),
    ['beta', 'answer:beta'],
  );
  assert.ok(a.runtime.getSnapshot().observation.overview.executions.every((execution) => execution.id !== alphaExecution));
  await a.runtime.openConversation(alpha.id);
  assert.deepEqual(
    a.runtime.getSnapshot().messages.map((message) => message.content),
    ['alpha', 'answer:alpha'],
  );
  assert.equal((await a.transport.conversation(alpha.id)).title, 'alpha');
  assert.equal((await b.transport.conversation(beta.id)).title, 'beta');
  await first.close();

  const restarted = await start();
  const next = await restarted.client();
  const listed = await next.transport.conversations();
  assert.deepEqual(new Set(listed.conversations.map((conversation) => conversation.id)), new Set([alpha.id, beta.id]));
  assert.equal(listed.defaultConversationId, alpha.id);
  assert.equal(restarted.calls.length, 0, 'restoration is not invocation recovery');
  await next.runtime.openConversation(beta.id);
  assert.deepEqual(
    next.runtime.getSnapshot().messages.map((message) => message.content),
    ['beta', 'answer:beta'],
  );
  await next.runtime.submit(request('beta again'));
  await until(() => next.runtime.getSnapshot().messages.length === 4);
  const answer = restarted.calls.find((call) => call.purpose === 'answer');
  assert.deepEqual(
    answer.input.memories.map((memory) => memory.content),
    ['beta'],
  );
  assert.ok(!JSON.stringify(answer.input).includes('alpha'));
  await next.runtime.openConversation(alpha.id);
  assert.equal(next.runtime.getSnapshot().messages.length, 2);
  const detail = await next.observation.execution(alpha.id, alphaExecution);
  assert.equal(detail.archive.state, 'sealed');
  assert.equal(detail.execution.status, 'succeeded');
});
