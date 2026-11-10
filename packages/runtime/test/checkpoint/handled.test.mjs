import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';

import { test } from 'node:test';

import { Scene, Node, Runner, Resources, checkpointPoint } from '@weiliang0121/capix-runtime';

import { cloneCheckpointImage, MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

import { capture, harness } from './fixtures/handled.mjs';

const iso = '2026-10-25T00:00:00.000Z';

const codec = { encode: (value) => value, decode: (value) => value };

for (const nested of [false, true])
  test(`${nested ? 'nested' : 'direct'} same-round failure handling survives a process boundary without rerunning either source or receiver`, () => {
    const fixture = new URL('./fixtures/handled.mjs', import.meta.url);
    const args = nested ? ['nested'] : [];
    const original = spawnSync(process.execPath, [fileURLToPath(fixture), 'capture', ...args], { encoding: 'utf8' });
    assert.equal(original.status, 0, original.stderr);
    const saved = JSON.parse(original.stdout);
    assert.equal(saved.result, iso);
    assert.deepEqual(saved.counters, { primary: 1, backup: 1, handled: 1 });
    assert.equal(saved.image.formatVersion, 6);
    assert.equal(saved.image.frame.round, 1);
    assert.equal(saved.image.frame.children[0].state.kind, 'failed');
    assert.equal(saved.image.frame.children[0].state.reception.kind, 'handled');
    if (nested) {
      const direct = saved.image.frame.children[0];
      assert.equal(direct.identity.kind, 'group');
      assert.notEqual(direct.identity.contextId, direct.state.failure.contextId, 'the Group delivers the deeper Node failure without rewriting its origin');
      assert.equal(
        saved.image.frame.children.some((child) => child.identity.contextId === direct.state.failure.contextId),
        false,
      );
      const forged = structuredClone(saved.image);
      forged.references.primary.contextId = direct.state.failure.contextId;
      assert.throws(() => cloneCheckpointImage(forged), /reference/);
    }
    assert.equal(saved.image.frame.children[1].state.kind, 'returned');
    assert.equal(saved.image.frame.children[1].state.reception.kind, 'accepted');
    const restored = spawnSync(process.execPath, [fileURLToPath(fixture), 'restore', ...args], { input: JSON.stringify(saved.image), encoding: 'utf8' });
    assert.equal(restored.status, 0, restored.stderr);
    const result = JSON.parse(restored.stdout);
    assert.equal(result.result, iso);
    assert.deepEqual(result.counters, { primary: 0, backup: 0, handled: 0 });
    assert.deepEqual(result.image.frame.children, saved.image.frame.children);
  });

test('restored handled failures are readonly facts and never become runnable children', async () => {
  const saved = await capture();
  const store = new MemoryCheckpointStore();
  store.save(saved.image, 0);
  const counters = { primary: 0, backup: 0, handled: 0 };
  await assert.rejects(harness(store, counters, { reopen: true }).resume(saved.image.frame.owner.contextId), /Historical failed child/);
  assert.deepEqual(counters, { primary: 0, backup: 0, handled: 0 });
});

test('checkpoint capture refuses an in-progress same-round failure callback', async () => {
  await assert.rejects(capture({ failDuringHandling: true }), /Only a prior round declared child exception/);
});

for (const boundary of ['save', 'finish']) {
  test(`checkpoint ${boundary} failure cannot be received as a recoverable child result`, async () => {
    const memory = new MemoryCheckpointStore();
    const fault = new Error(`checkpoint ${boundary} disk failure`);
    const writes = { save: 0, finish: 0 };
    const store = {
      read: (id) => memory.read(id),
      save(image, revision) {
        writes.save++;
        if (boundary === 'save') throw fault;
        return memory.save(image, revision);
      },
      finish(id, revision, delivery) {
        writes.finish++;
        if (boundary === 'finish') throw fault;
        return memory.finish(id, revision, delivery);
      },
    };
    const point = checkpointPoint()({ name: 'fixed', state: codec, references: {}, resume: { run: () => 'source result' } });
    const child = new Node({
      checkpoint: { key: `fixture.checkpoint-fault.${boundary}`, version: 1, input: codec, output: codec, points: [point] },
      run(work) {
        work.checkpoint({ point, state: null });
        return 'source result';
      },
    });
    let received = 0;
    const scene = new Scene({
      run: (work) =>
        work.children.invoke(child, null, {
          result: {
            failed() {
              received++;
              return 'masked storage failure';
            },
          },
        }),
    }).add(child);
    const runner = new Runner(scene, new Resources(), undefined, { checkpoints: { store } }).build();
    await assert.rejects(runner.run(null), /checkpoint/);
    assert.equal(received, 0, 'mechanism failure never enters the business failure receiver');
    assert.ok(writes[boundary] > 0);
    assert.equal(runner.isRunning, false);
  });
}
