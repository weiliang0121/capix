import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelCompletionIncomplete, defaultConversationOutputBudget } from '@capix/conversation-service';
import { createConversationInteractions, createConversationResources, createMaterialConversationScene, loadConversationContent } from '@capix/conversation-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { Runner } from '@weiliang0121/capix-runtime';

const reply = (text, finishReason = 'stop') => ({ id: 'budget-fixture', model: 'offline', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: finishReason === 'stop' ? 'completed' : 'incomplete', reason: finishReason }, usage: null });

async function fixture(t, budget, answerReason = 'stop', memoryReason = 'stop') {
  const directory = await mkdtemp(join(tmpdir(), 'capix-output-budget-'));
  const store = ConversationStore.open(join(directory, 'conversation.sqlite'));
  const content = loadConversationContent(store);
  const requests = [];
  const model = {
    async complete(request, controls = {}) {
      requests.push(request);
      if (request.responseFormat === 'json_object') return reply('{"changes":[]}', memoryReason);
      controls.emit?.('候选内容');
      return reply('正式内容', answerReason);
    },
  };
  const interactions = createConversationInteractions(model, store.interactions);
  const scene = createMaterialConversationScene(budget);
  const runner = new Runner(scene, createConversationResources(content, model, store.view), interactions, { checkpoints: { store: store.checkpoints } }).build();
  t.after(async () => {
    await interactions.settled();
    interactions.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { runner, store, content, requests };
}

test('default output ceilings leave headroom and are fixed in both requests and recovery basis', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.runner.run('综合多个主题'), '正式内容');
  assert.deepEqual(
    f.requests.map((r) => r.maxTokens),
    [4096, 8192],
  );
  assert.deepEqual(defaultConversationOutputBudget, { answer: 4096, memory: 8192 });
  const head = f.store.checkpoints.listRoots()[0];
  assert.equal(head.image.contract.version, 3);
  assert.deepEqual(head.image.state.outputBudget, defaultConversationOutputBudget);
});

test('explicit budgets are captured at assembly, independently configurable, and not mutated later', async (t) => {
  const budget = { answer: 2111, memory: 4222 };
  const f = await fixture(t, budget);
  budget.answer = 9;
  budget.memory = 10;
  await f.runner.run('custom');
  assert.deepEqual(
    f.requests.map((r) => r.maxTokens),
    [2111, 4222],
  );
  assert.deepEqual(f.store.checkpoints.listRoots()[0].image.state.outputBudget, { answer: 2111, memory: 4222 });
});

test('length stays a rejection with safe budget diagnosis, no assistant append, no maintenance, no retry', async (t) => {
  const f = await fixture(t, { answer: 137 }, 'length');
  await assert.rejects(f.runner.run('long'), (error) => {
    assert.ok(error instanceof ModelCompletionIncomplete);
    assert.equal(error.code, 'MODEL_OUTPUT_LIMIT');
    assert.equal(error.maxTokens, 137);
    assert.equal(error.finishReason, 'length');
    assert.match(error.message, /137 token/);
    assert.doesNotMatch(error.message, /候选内容|正式内容/);
    return true;
  });
  assert.equal(f.requests.length, 1);
  assert.equal(f.content.transcript.length, 1);
  assert.equal(f.store.checkpoints.listRoots()[0].delivery.status, 'failed');
});

test('memory output exhaustion remains handled without changing the formal answer or retrying', async (t) => {
  const f = await fixture(t, { memory: 131 }, 'stop', 'length');
  assert.equal(await f.runner.run('remember'), '正式内容');
  assert.deepEqual(
    f.requests.map((r) => r.maxTokens),
    [4096, 131],
  );
  assert.equal(f.content.transcript.length, 2);
  assert.equal(f.content.memories.values().length, 0);
});

test('invalid budgets fail during assembly, before a model request or content mutation', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '4096']) {
    assert.throws(() => createMaterialConversationScene({ answer: value }), /positive safe integer/);
    assert.throws(() => createMaterialConversationScene({ memory: value }), /positive safe integer/);
  }
});
