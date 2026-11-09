import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompletionInteraction, createCompletionNode } from '@capix/conversation-service';
import { loadConversationContent } from '@capix/conversation-service/assembly';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { Interaction } from '@weiliang0121/capix-interaction';

const request = { messages: [{ role: 'user', content: 'question' }] };
const baseUsage = { promptTokens: 20, completionTokens: 5, totalTokens: 25 };
const reply = (usage) => ({ id: 'reply', model: 'fixture', formatVersion: 1, output: [{ kind: 'text', text: 'answer' }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage });

test('completion contract and CP codecs preserve optional cache counts and reject inconsistent usage', () => {
  const node = createCompletionNode();
  const codecs = [node.checkpoint.output, node.checkpoint.points[0].state];
  for (const usage of [null, baseUsage, { ...baseUsage, promptCacheHitTokens: 0 }, { ...baseUsage, promptCacheMissTokens: 20 }, { ...baseUsage, promptCacheHitTokens: 12, promptCacheMissTokens: 8 }]) {
    const value = reply(usage);
    assert.equal(CompletionInteraction.reply(value), value);
    for (const codec of codecs) assert.deepEqual(codec.decode(codec.encode(value)), value);
  }
  const invalid = [];
  for (const field of ['promptCacheHitTokens', 'promptCacheMissTokens']) {
    for (const value of [-1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1, 21]) invalid.push({ [field]: value });
  }
  invalid.push({ promptCacheHitTokens: 10, promptCacheMissTokens: 9 }, { promptCacheHitTokens: 10, promptCacheMissTokens: 11 });
  for (const fields of invalid) {
    const value = reply({ ...baseUsage, ...fields });
    assert.throws(() => CompletionInteraction.reply(value), TypeError);
    for (const codec of codecs) assert.throws(() => codec.decode(value));
  }
});

test('cache usage and current replies survive Interaction and CP persistence reopening', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'capix-cache-usage-'));
  const path = join(directory, 'conversation.sqlite');
  const opened = [];
  t.after(() => {
    for (const store of opened) store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const store = ConversationStore.open(path);
  opened.push(store);
  loadConversationContent(store);
  const node = createCompletionNode();
  const point = node.checkpoint.points[0];
  const results = [];
  for (const usage of [null, baseUsage, { ...baseUsage, promptCacheHitTokens: 0 }, { ...baseUsage, promptCacheHitTokens: 12, promptCacheMissTokens: 8 }]) {
    const value = reply(usage);
    const interaction = new Interaction(request, { contract: CompletionInteraction, persistence: store.interactions });
    interaction.start(() => value);
    await interaction.settled();
    const contextId = `completion-${results.length}`;
    const input = node.checkpoint.input.encode(request);
    store.checkpoints.save({ id: `image-${results.length}`, formatVersion: 6, contract: { key: node.checkpoint.key, version: node.checkpoint.version }, point: point.name, frame: { owner: { contextId, kind: 'node' }, round: 1, phase: 'execute', input, currentInput: input, nextChildOrder: 0, children: [] }, state: point.state.encode(value), references: {} }, 0);
    store.checkpoints.finish(contextId, 1, { status: 'succeeded', output: node.checkpoint.output.encode(value), progress: { round: 1, currentInput: input, phase: 'execute' } });
    results.push({ contextId, interactionId: interaction.id, value });
  }
  store.close();
  const reopened = ConversationStore.open(path);
  opened.push(reopened);
  for (const { contextId, interactionId, value } of results) {
    const interaction = Interaction.restore(reopened.interactions.read(interactionId), { contract: CompletionInteraction });
    assert.deepEqual(interaction.read().feedback.payload, value);
    assert.throws(() => interaction.start(() => assert.fail('restoring feedback cannot send again')), { code: 'INTERACTION_RESTORED' });
    const head = reopened.checkpoints.read(contextId);
    assert.deepEqual(point.state.decode(head.image.state), value);
    assert.deepEqual(node.checkpoint.output.decode(head.delivery.output), value);
  }
});
