import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Scene, Group, MemoryCheckpointStore, checkpointPoint, childReference } from '@capix/server-runtime';
import { Transcript, Memories, MemoryResource } from '@capix/server-runtime/content';
import { ExtractMemory, SaveResult, ModelInteractions, ModelSource, ModelResource, ModelSettingsResource } from '@capix/observer-service/conversation';
import { WorkspaceFiles, FileResources } from '@capix/observer-service/assembly';

const codec = { encode: structuredClone, decode: structuredClone };
class CaptureStore extends MemoryCheckpointStore {
  ids = new Set();
  snapshots = new Map();
  save(image, revision) {
    const head = super.save(image, revision);
    this.ids.add(image.frame.owner.contextId);
    const snapshot = new MemoryCheckpointStore();
    for (const id of this.ids) {
      const current = this.read(id);
      snapshot.save(current.image, 0);
      if (current.delivery) snapshot.finish(id, 1, current.delivery);
    }
    this.snapshots.set(`${image.contract.key}:${image.point}`, snapshot);
    return head;
  }
}
function harness(operation, providers, store, requires = operation.run.requires) {
  const checkpoint = (key, child) => ({
    key,
    version: 1,
    input: codec,
    output: codec,
    points: [
      checkpointPoint()({
        name: 'waiting',
        state: codec,
        references: { child: childReference(child) },
        resume: {
          requires: {},
          uses: [child],
          async execute(work, _state, saved) {
            const call = work.children.resume(saved.child);
            await call.run();
            return call.accept();
          },
        },
      }),
    ],
  });
  class Execution extends Group {
    members = [operation];
    checkpoint = checkpoint('effects.execution', operation);
    run = {
      requires,
      execute: async (work) => {
        const call = work.children.create(operation, work.input, { key: 'operation' });
        work.checkpoint.save(this.checkpoint.points[0], {}, { child: call.ref });
        await call.run();
        return call.accept();
      },
    };
  }
  const execution = new Execution();
  class Root extends Scene {
    members = [execution];
    checkpoint = checkpoint('effects.runtime', execution);
    run = {
      requires: {},
      execute: async (work) => {
        const call = work.children.create(execution, work.input, { key: 'execution' });
        work.checkpoint.save(this.checkpoint.points[0], {}, { child: call.ref });
        await call.run();
        return call.accept();
      },
    };
  }
  return installCallable(new Root(), { checkpoints: { store }, providers, source: { capture: () => null } });
}
function rootId(store) {
  return [...store.ids].find((id) => store.read(id).image.contract.key === 'effects.runtime');
}

test('extract-memory resumes a committed application from its old waiting CP without model resubmission or a duplicate memory', async (t) => {
  const transcript = new Transcript([
    { role: 'user', content: 'retain this' },
    { role: 'assistant', content: 'accepted' },
  ]);
  const memories = new Memories(transcript);
  const input = { currentIndexes: [0, 1], messages: transcript.snapshot().map((message, index) => ({ index, message })), memories: [] };
  const output = { memories: [{ action: 'create', memoryId: null, change: 'a useful fact', sourceIndexes: [0, 1], result: { topic: 'topic', content: 'content', sourceIndexes: [0, 1] } }] };
  let requests = 0;
  const interactions = new ModelInteractions(
    new ModelSource({
      async invoke() {
        requests++;
        return { id: 'test', model: 'fixture', content: JSON.stringify(output), finishReason: 'stop', usage: null };
      },
    }),
  );
  t.after(() => interactions.close());
  const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
  const providers = (entity) => [MemoryResource.apply.provide(() => entity), ModelSettingsResource.snapshot.provide(() => settings), ModelSettingsResource.timeout.provide(() => settings.timeoutMs), ModelResource.create.provide(() => interactions), ModelResource.read.provide(() => interactions)];
  const store = new CaptureStore();
  const original = harness(new ExtractMemory(), providers(memories), store);
  assert.deepEqual(await original.run(input, {}), output);
  assert.equal(requests, 1);
  const snapshot = store.snapshots.get('observer.apply-memory:prepared');
  assert.ok(snapshot);
  const restoredMemories = Memories.restore(memories.exportState(), transcript, {
    changes: {
      capture() {
        assert.fail('no duplicate mutation');
      },
    },
  });
  const restored = harness(new ExtractMemory(), providers(restoredMemories), snapshot);
  assert.deepEqual(await restored.resume(rootId(store), {}), output);
  assert.equal(requests, 1);
  assert.equal(restoredMemories.sequence, 1);
  assert.equal(restoredMemories.values().length, 1);
});

test('save-result resumes a committed fixed file receipt from the old creation CP without writing again', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'capix-checkpoint-file-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = new WorkspaceFiles({ root });
  const store = new CaptureStore();
  const providers = [FileResources.createText.provide(() => ({ files, path: 'result.md' }))];
  const input = { path: 'result.md', text: 'fixed result' };
  const original = harness(new SaveResult(), providers, store);
  const receipt = await original.run(input, {});
  const snapshot = store.snapshots.get('observer.create-text:prepared');
  assert.ok(snapshot);
  await unlink(join(root, 'result.md'));
  const restored = harness(new SaveResult(), providers, snapshot);
  assert.deepEqual(await restored.resume(rootId(store), {}), receipt);
  await assert.rejects(readFile(join(root, 'result.md')), { code: 'ENOENT' });
});
