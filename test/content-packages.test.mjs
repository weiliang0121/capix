import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RuntimeError } from '@weiliang0121/capix-contracts';
import { PersistenceError } from '@weiliang0121/capix-diagnostics';
import { ChangeCaptureError, ChangeBuffer } from '@weiliang0121/capix-changes';
import { Resource, Resources, ResourceAccessClosed } from '@weiliang0121/capix-resources';
import { Transcript, TranscriptResource } from '@weiliang0121/capix-transcript';
import { Memory, Memories, MemoryResource } from '@weiliang0121/capix-memory';
import { ActiveView, ActiveViewResource, ConversationContent } from '@capix/observer-content';

const packages = [
  { path: 'server/changes', name: '@weiliang0121/capix-changes', exports: ['ChangeBuffer', 'ChangeCaptureError', 'ProgressChannel'] },
  { path: 'server/transcript', name: '@weiliang0121/capix-transcript', exports: ['Transcript', 'MessageRef', 'TranscriptRangeRef', 'TranscriptResource', 'TranscriptViewSource'] },
  { path: 'server/memory', name: '@weiliang0121/capix-memory', exports: ['Memory', 'Memories', 'MemoryResource', 'MemoryViewSource'] },
  { path: 'server/view', name: '@weiliang0121/capix-view', exports: ['View', 'openView', 'openViewManager'] },
  { path: 'server/measurement', name: '@weiliang0121/capix-measurement', exports: ['MessageUsage', 'MessageUsageResource'] },
  { path: 'services/observer-content', name: '@capix/observer-content', exports: ['ConversationContent', 'ActiveView', 'ActiveViewResource', 'ChangeConsumer', 'TranscriptFeed'] },
];

const create = (content) => ({ action: 'create', memoryId: null, change: 'new understanding', sourceIndexes: [0], result: { topic: 'topic', content, sourceIndexes: [0] } });
const fixedRequest = (memories, input, contextId = 'content-host') => ({ contract: { key: 'memories.apply', version: 1 }, operation: { contextId, position: input.position }, memoriesId: memories.id, changes: input.changes });
const failures = { isProtected: (error) => error instanceof RuntimeError, isCancellation: () => false, describe: (error) => ({ message: error.message }) };
const owner = (extra = {}) => ({ contextId: 'content-host', failures, validate() {}, ...extra });
const memoryBinding = (memories) => new Resources().register(new Resource(memories), MemoryResource.apply).bind({ memory: MemoryResource.apply.request() });

test('content packages load through public roots without importing callable structures or runtime', async () => {
  async function inspect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
      if (entry.isDirectory()) await inspect(path);
      else if (entry.name.endsWith('.ts')) {
        const source = await readFile(path, 'utf8');
        assert.doesNotMatch(source, /@weiliang0121\/capix-(?:structure|runtime)|@capix\/observer-service|(?:\.\.\/)+(?:structure|runtime)\//, fileURLToPath(path));
      }
    }
  }
  for (const pkg of packages) {
    const directory = new URL(`../${pkg.path}/`, import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('package.json', directory), 'utf8'));
    assert.equal(manifest.name, pkg.name);
    for (const dependency of [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})]) assert.ok(!['@weiliang0121/capix-structure', '@weiliang0121/capix-runtime', '@capix/observer-service'].includes(dependency), `${pkg.name} cannot depend on ${dependency}`);
    await inspect(new URL('src/', directory));
    await inspect(new URL('dist/', directory));
    const exported = await import(pkg.name);
    for (const name of pkg.exports) assert.ok(name in exported, `${pkg.name} must export ${name}`);
    for (const name of ['Runner', 'Invocation', 'Scene', 'Group', 'Node', 'Recorder', 'updateMemory', 'restoreMemory']) assert.equal(name in exported, false, `${pkg.name} must not expose ${name}`);
  }
  for (const path of ['@weiliang0121/capix-memory/memory', '@weiliang0121/capix-memory/src/memory.js', '@weiliang0121/capix-memory/dist/memory.js']) await assert.rejects(import(path), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
});

test('generic view has no transcript, memory or Observer active-membership policy', async () => {
  const exported = await import('@weiliang0121/capix-view');
  for (const name of ['Transcript', 'Memories', 'TranscriptViewSource', 'MemoryViewSource', 'ActiveView', 'ActiveViewResource', 'initialActiveView', 'appendActiveView', 'freezeActiveView']) assert.equal(name in exported, false, `@weiliang0121/capix-view must not own ${name}`);
  const manifest = JSON.parse(await readFile(new URL('../server/view/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ['@weiliang0121/capix-contracts', '@weiliang0121/capix-diagnostics', '@weiliang0121/capix-resources']);
});

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

test('memory storage failure is classified by the entity and crosses the offer without installing content or a receipt', () => {
  const transcript = new Transcript([{ role: 'user', content: 'input' }]);
  const cause = new Error('storage unavailable');
  const changes = new ChangeBuffer();
  let reject = true;
  const writes = [];
  const memories = new Memories(transcript, {
    changes,
    persistence: {
      commit(change) {
        if (reject) throw cause;
        writes.push(change);
      },
    },
  });
  const reported = [];
  const access = memoryBinding(memories).open(
    owner({
      error: (error) => {
        reported.push(error);
      },
    }),
  );
  try {
    const input = { position: 'remember', changes: [create('remembered')] };
    let failure;
    assert.throws(
      () => access.endpoints.memory.applyFixed(input),
      (error) => {
        failure = error;
        return error instanceof PersistenceError && error.operation === 'memories.commit' && error.cause === cause;
      },
    );
    assert.equal(memories.sequence, 0);
    assert.deepEqual(memories.values(), []);
    assert.equal(memories.confirmFixed(fixedRequest(memories, input)), undefined);
    assert.equal(changes.size, 0);
    assert.ok(reported.includes(failure));
    reject = false;
    const receipt = access.endpoints.memory.applyFixed(input);
    assert.equal(receipt.sequence, 1);
    assert.equal(writes.length, 1);
    assert.equal(changes.size, 1);
  } finally {
    access.close();
  }
});

test('post-commit capture failure retains shared error identity and can confirm the fixed result without replay', () => {
  const transcript = new Transcript([{ role: 'user', content: 'input' }]);
  const cause = new Error('capture unavailable');
  const writes = [];
  const events = [];
  const observed = [];
  const memories = new Memories(transcript, {
    persistence: {
      commit: (change) => {
        writes.push(change);
      },
    },
    changes: {
      capture(event) {
        events.push(event);
        throw cause;
      },
    },
  });
  const reported = [];
  const access = memoryBinding(memories).open(
    owner({
      memory: {
        publish: (event) => {
          observed.push(event);
        },
      },
      error: (error) => {
        reported.push(error);
      },
    }),
  );
  const input = { position: 'remember', changes: [create('remembered')] };
  try {
    let failure;
    assert.throws(
      () => access.endpoints.memory.applyFixed(input),
      (error) => {
        failure = error;
        return error instanceof ChangeCaptureError && error instanceof RuntimeError && error.code === 'CHANGE_CAPTURE_FAILED' && error.cause === cause;
      },
    );
    assert.ok(reported.includes(failure));
    assert.equal(failure.event, events[0]);
    assert.equal(observed[0], events[0], 'optional observation still receives the committed fact');
    assert.equal(events[0].origin.contextId, 'content-host');
    assert.equal(memories.sequence, 1);
    const receipt = access.endpoints.memory.applyFixed(input);
    assert.equal(receipt, memories.confirmFixed(fixedRequest(memories, input)));
    assert.equal(writes.length, 1);
    assert.equal(events.length, 1);
    const restoredTranscript = Transcript.restore(transcript.exportState());
    const restored = Memories.restore(memories.exportState(), restoredTranscript, {
      persistence: {
        commit() {
          assert.fail('fixed result must not be written again');
        },
      },
    });
    const recovery = memoryBinding(restored).open(owner());
    try {
      assert.deepEqual(recovery.endpoints.memory.applyFixed(input), receipt);
      assert.equal(restored.values()[0].transcript, restoredTranscript);
    } finally {
      recovery.close();
    }
  } finally {
    access.close();
  }
});
