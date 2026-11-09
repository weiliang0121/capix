import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { Scene, Node, Runner, Resources, checkpointPoint } from '@weiliang0121/capix-runtime';
import { cloneCheckpointImage, MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { decodeCheckpointFrame } from '@weiliang0121/capix-runtime/construction';
import { capture, harness, iso } from './fixtures/handled.mjs';

const codec = { encode: (value) => value, decode: (value) => value };
const binding = { position: 0, childPosition: 0, check: (value) => assert.equal(typeof value?.iso, 'string'), codec: { encode: (value) => value.iso, decode: (value) => ({ iso: value }) } };

function image() {
  return {
    id: 'handled-image',
    formatVersion: 6,
    contract: { key: 'parent', version: 1 },
    point: 'handled',
    frame: {
      owner: { contextId: 'parent', kind: 'scene' },
      round: 1,
      phase: 'execute',
      input: null,
      currentInput: null,
      nextChildOrder: 1,
      children: [
        {
          identity: { contextId: 'child', parentContextId: 'parent', kind: 'node' },
          target: { position: 0 },
          round: 1,
          order: 0,
          input: null,
          state: {
            kind: 'failed',
            error: { code: 'ERROR', message: 'primary failed' },
            failure: { kind: 'error', phase: 'execute', contextId: 'child' },
            progress: { round: 1, currentInput: null, phase: 'execute' },
            reception: { kind: 'handled', contract: { position: 0 }, output: iso },
          },
        },
      ],
    },
    state: null,
    references: {},
  };
}
const decode = (source, receptions = [binding]) => decodeCheckpointFrame(cloneCheckpointImage(source).frame, { input: codec, output: codec }, [{ kind: 'node' }], receptions);

test('v6 keeps a same-round failure and its typed handled result as independent facts', () => {
  const decoded = decode(image());
  const state = decoded.children[0].state;
  assert.equal(state.kind, 'failed');
  assert.equal(state.failure.kind, 'error');
  assert.equal(state.reception.kind, 'handled');
  assert.equal(state.reception.output.iso, iso);
  assert.equal(state.error instanceof Error, false);
  const raw = image();
  raw.frame.children[0].state.reception = { kind: 'handled' };
  assert.equal(decode(raw, []).children[0].state.reception.output, undefined);
});

test('handled undefined has an explicit codec and cannot be confused with missing handling', () => {
  const source = image();
  source.frame.children[0].state.reception.output = null;
  const receptions = [
    {
      ...binding,
      check: (value) => assert.equal(value, undefined),
      codec: {
        encode: () => null,
        decode: (value) => {
          assert.equal(value, null);
          return undefined;
        },
      },
    },
  ];
  const handled = decode(source, receptions).children[0].state.reception;
  assert.equal(handled.kind, 'handled');
  assert.equal(Object.hasOwn(handled, 'output'), true);
  assert.equal(handled.output, undefined);
});

test('v6 rejects unfinished, misattributed or relabelled same-round failure handling', () => {
  const mutations = [
    (source) => {
      delete source.frame.children[0].state.reception;
    },
    ...['pending', 'receiving', 'accepted', 'failed'].map((kind) => (source) => {
      source.frame.children[0].state.reception.kind = kind;
    }),
    (source) => {
      source.frame.children[0].state.failure.contextId = '';
    },
    (source) => {
      source.frame.children[0].identity.parentContextId = 'another-parent';
    },
    (source) => {
      source.frame.children[0].state.failure.phase = 'imagined';
    },
    ...['setup', 'control', 'observation'].map((phase) => (source) => {
      source.frame.children[0].state.failure.phase = phase;
    }),
    (source) => {
      source.frame.children[0].state.failure.kind = 'exception';
    },
    (source) => {
      source.frame.children[0].state.output = 'pretend success';
    },
    (source) => {
      delete source.frame.children[0].state.reception.output;
    },
    (source) => {
      source.frame.children[0].state.reception.contract.position = -1;
    },
  ];
  for (const mutate of mutations) {
    const source = image();
    mutate(source);
    assert.throws(() => cloneCheckpointImage(source), /Invalid checkpoint/);
  }
  const source = image();
  source.frame.children[0].state.failure = { kind: 'exception', phase: 'execute', contextId: 'child', contract: 'bad-answer' };
  assert.equal(cloneCheckpointImage(source).frame.children[0].state.failure.kind, 'exception');
  source.formatVersion = 4;
  assert.throws(() => cloneCheckpointImage(source), /formatVersion 6/);
});

test('handled codecs remain attached to the exact parent reception and child positions', () => {
  assert.throws(() => decode(image(), []), /reception contract position/);
  assert.throws(() => decode(image(), [{ ...binding, childPosition: 1 }]), /child declaration/);
  assert.throws(() => decode(image(), [{ ...binding, codec: { ...binding.codec, decode: () => ({ invalid: true }) } }]), /assertion|equal/i);
});

for (const nested of [false, true])
  test(`${nested ? 'nested' : 'direct'} same-round failure handling survives a process boundary without rerunning either source or receiver`, () => {
    const fixture = new URL('./fixtures/handled.mjs', import.meta.url);
    const args = nested ? ['nested'] : [];
    const original = spawnSync(process.execPath, [fixture.pathname, 'capture', ...args], { encoding: 'utf8' });
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
    const restored = spawnSync(process.execPath, [fixture.pathname, 'restore', ...args], { input: JSON.stringify(saved.image), encoding: 'utf8' });
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
