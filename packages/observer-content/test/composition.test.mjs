import assert from 'node:assert/strict';

import { test } from 'node:test';

import { RuntimeError } from '@weiliang0121/capix-contracts';

import { ChangeBuffer } from '@weiliang0121/capix-changes';

import { Resource, Resources, ResourceAccessClosed } from '@weiliang0121/capix-resources';

import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';

import { Memory, Memories, MemoryResource } from '@weiliang0121/capix-memory';

import { ActiveView, ActiveViewResource, ConversationContent } from '@capix/observer-content';

const create = (content) => ({ action: 'create', memoryId: null, change: 'new understanding', sourceIndexes: [0], result: { topic: 'topic', content, sourceIndexes: [0] } });

const failures = { isProtected: (error) => error instanceof RuntimeError, isCancellation: () => false, describe: (error) => ({ message: error.message }) };

const owner = (extra = {}) => ({ contextId: 'content-host', failures, validate() {}, ...extra });

test('the host content composition uses the package entities and preserves exact source ownership', () => {
  const content = new ConversationContent({ messages: [{ role: 'user', content: 'input' }] });
  let restored;
  try {
    assert.ok(content.transcript instanceof Transcript);
    assert.ok(content.memories instanceof Memories);
    assert.ok(content.active instanceof ActiveView);
    assert.ok(content.changes instanceof ChangeBuffer);
    const [memory] = content.memories.apply([create('remembered')]);
    assert.ok(memory instanceof Memory);
    assert.equal(memory.transcript, content.transcript);
    assert.equal(content.memories.transcript, content.transcript);
    assert.equal(content.active.capture().memories[0].id, memory.id);
    const saved = { version: 1, transcript: content.transcript.exportState(), memories: content.memories.exportState(), active: content.active.exportState() };
    restored = new ConversationContent({ saved });
    assert.equal(restored.memories.get(memory.id).transcript, restored.transcript);
    assert.equal(restored.transcript.id, content.transcript.id);
    assert.notEqual(restored.transcript, content.transcript);
    assert.deepEqual(restored.active.capture(), content.active.capture());
    assert.throws(() => new ActiveView(restored.transcript, content.memories), /another content scope/);
    assert.throws(() => Memories.restore(saved.memories, new Transcript([{ role: 'user', content: 'other' }])), /Invalid persisted memory collection/);
  } finally {
    restored?.close();
    content.close();
  }
});

test('content offers keep fixed writes and active membership inside independent resource windows', () => {
  const changes = new ChangeBuffer();
  const writes = [];
  const transcript = new Transcript([{ role: 'user', content: 'input' }]);
  const memories = new Memories(transcript, {
    changes,
    persistence: {
      commit: (change) => {
        writes.push(change);
      },
    },
  });
  const active = new ActiveView(transcript, memories);
  const binding = new Resources().register(new Resource(transcript), TranscriptResource.append).register(new Resource(memories), MemoryResource.apply).register(new Resource(active), ActiveViewResource.manage).bind({ transcript: TranscriptResource.append.request(), memory: MemoryResource.apply.request(), active: ActiveViewResource.manage.request() });
  const first = binding.open(owner());
  const { memory, active: manager, transcript: messages } = first.endpoints;
  const input = { position: 'remember', changes: [create('remembered')] };
  const receipt = memory.applyFixed(input);
  assert.equal(memory.applyFixed(input), receipt);
  assert.equal(writes.length, 1);
  assert.equal(changes.size, 1);
  const before = manager.capture();
  assert.equal(before.memories[0].id, receipt.memoryIds[0]);
  manager.apply({ basis: before.basis, messageIndexes: [], memoryIds: [] });
  assert.deepEqual(manager.capture().memories, []);
  assert.equal(memories.values().length, 1, 'leaving the active index does not remove the entity');
  messages.append([{ role: 'assistant', content: 'answer' }]);
  assert.deepEqual(
    manager.capture().messages.map((item) => item.index),
    [1],
  );
  first.close();
  assert.throws(() => memory.applyFixed(input), ResourceAccessClosed);
  assert.throws(() => manager.capture(), ResourceAccessClosed);
  assert.throws(() => messages.append([{ role: 'user', content: 'too late' }]), ResourceAccessClosed);
  const next = binding.open(owner());
  try {
    assert.equal(next.endpoints.memory.applyFixed(input), receipt);
    assert.equal(writes.length, 1);
    assert.equal(transcript.length, 2);
    assert.equal(changes.size, 1);
  } finally {
    next.close();
  }
});
