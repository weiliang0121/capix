import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { Runner } from '@weiliang0121/capix-runtime';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent, createConversationHostAssembly } from '@capix/conversation-service/assembly';
import { CompletionInteraction } from '@capix/conversation-service';
import { Interaction } from '@weiliang0121/capix-interaction';

function model(complete) {
  const encoder = new ChatCompletionsProvider({
    endpoint: 'https://fixture.invalid',
    model: 'fixture',
    apiKey: 'fixture',
    fetch: () => {
      throw new Error('offline');
    },
  });
  return { inspectRequest: (request) => encoder.inspectRequest(request), complete };
}
const reply = (text = 'answer') => ({ formatVersion: 1, id: 'fixture', model: 'fixture', output: [{ kind: 'text', text }], termination: { kind: 'completed', reason: 'stop' }, native: { format: 'chat-completions', version: 1 }, usage: null });
async function host(t, answerMode, provider, archivePolicy) {
  const directory = await mkdtemp(join(tmpdir(), 'capix-host-entry-'));
  const store = ConversationStore.open(join(directory, 'conversation.sqlite'));
  const content = loadConversationContent(store);
  const assembly = createConversationHostAssembly({ store, content, model: provider, answerMode, configuration: 'host-entry-test', archivePolicy });
  const runner = new Runner(assembly.scene, assembly.resources, assembly.interactions, { checkpoints: { store: assembly.checkpoints }, validate: assembly.assertAdmission }).build();
  t.after(async () => {
    await assembly.interactions.settled();
    assembly.interactions.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { store, content, assembly, runner, entry: assembly.entry(runner) };
}

test('both material and tool write entries use the same archive gate before formal input; reads stay available', async (t) => {
  for (const mode of ['material', 'tools']) {
    let requests = 0;
    const current = await host(
      t,
      mode,
      model(async () => {
        requests++;
        return reply();
      }),
      { thresholdBytes: 2, headroomBytes: 1, maxPendingReplyBytes: 1 },
    );
    // A durable, unrelated interaction is enough to exceed the deliberately tiny fixture gate.
    new Interaction({ messages: [{ role: 'user', content: 'retained' }] }, { contract: CompletionInteraction, persistence: current.store.interactions });
    await assert.rejects(current.entry.run('must not append'), { code: 'CONVERSATION_ARCHIVE_FULL', message: /交换 \d+ bytes，模型交互 \d+ bytes，CP \d+ bytes/ });
    assert.equal(current.content.transcript.length, 0);
    assert.equal(requests, 0);
    assert.equal(current.runner.isRunning, false);
    assert.equal(current.assembly.exchanges.loadedCount, 0);
    assert.doesNotThrow(current.assembly.assertAvailable);
    assert.deepEqual(current.assembly.listRecoveries(), []);
    assert.equal(current.store.exchanges.list().items.length, 0);
  }
});

test('local cancellation closes its supply use while the independent sender can persist late feedback', { timeout: 10_000 }, async (t) => {
  let started;
  const active = new Promise((resolve) => {
    started = resolve;
  });
  let complete;
  const delayed = new Promise((resolve) => {
    complete = resolve;
  });
  let calls = 0;
  const current = await host(
    t,
    'tools',
    model(async (request) => {
      if (request.responseFormat === 'json_object') return reply('{"changes":[]}');
      calls++;
      if (calls === 1) {
        started();
        return delayed;
      }
      return reply('next answer');
    }),
  );
  const running = current.entry.run('first');
  await active;
  assert.equal(current.assembly.interactions.pendingCount, 1);
  const busy = current.entry.run('must not enter');
  await assert.rejects(busy);
  assert.equal(current.content.transcript.length, 1);
  assert.equal(current.assembly.exchanges.loadedCount, 1);
  current.runner.cancel();
  await assert.rejects(running);
  assert.equal(current.assembly.exchanges.loadedCount, 0);
  assert.equal(current.assembly.interactions.pendingCount, 1);
  const retained = current.store.archiveUsage().interactionsBytes;
  complete(reply('late feedback is still saved'));
  await current.assembly.interactions.settled();
  assert.equal(current.assembly.interactions.pendingCount, 0);
  assert.ok(current.store.archiveUsage().interactionsBytes > retained);
  assert.equal(await current.entry.run('second'), 'next answer');
  assert.equal(current.content.transcript.length, 3);
  assert.equal(current.assembly.exchanges.loadedCount, 0);
  assert.equal(current.store.exchanges.list().items.length, 2);
  assert.equal(calls, 2);
});
