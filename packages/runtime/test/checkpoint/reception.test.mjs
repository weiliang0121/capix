import { fileURLToPath } from 'node:url';
import { installCallable } from '../fixtures/driver.mjs';

import assert from 'node:assert/strict';

import { test } from 'node:test';

import { spawnSync } from 'node:child_process';

import { defineScene, defineGroup, reception, checkpointPoint } from '@weiliang0121/capix-runtime';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

const codec = { encode: (value) => value, decode: (value) => value };

function processFixture(mode, variant, head) {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/reception.mjs', import.meta.url)), mode, ...(variant ? [variant] : [])], { cwd: fileURLToPath(new URL('../../', import.meta.url)), input: head ? JSON.stringify(head) : undefined, encoding: 'utf8' });
}

test('typed reception restores date records and undefined in a new process without re-running children or reception callbacks', () => {
  const captured = processFixture('capture');
  assert.equal(captured.status, 0, captured.stderr);
  const head = JSON.parse(captured.stdout);
  assert.equal(head.image.formatVersion, 6);
  assert.deepEqual(
    head.image.frame.children.map((child) => child.state.reception.contract.position),
    [0, 0, 1],
  );
  assert.equal(Object.hasOwn(head.image.frame.children[2].state.reception, 'output'), true);
  assert.equal(head.image.frame.children[2].state.reception.output, null);
  const restored = processFixture('restore', undefined, head);
  assert.equal(restored.status, 0, restored.stderr);
  const result = JSON.parse(restored.stdout);
  assert.notEqual(result.pid, head.image.state.pid);
  assert.equal(result.value, '2026-01-01T00:00:00.000Z');
  assert.equal(result.empty, 'accepted');
  for (const [variant, pattern] of [
    ['version', /version|contract|checkpoint/],
    ['reject-codec', /rejects date encoding/],
    ['wrong-contract', /no accepted value under this reception contract/],
    ['swap', /AssertionError/],
  ]) {
    const rejected = processFixture('restore', variant, head);
    assert.notEqual(rejected.status, 0, variant);
    assert.match(rejected.stderr, pattern, variant);
  }
});

test('receiving restoration keeps its original typed or raw contract before entering a callback', () => {
  const run = (mode, variant, head) => spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/receiving.mjs', import.meta.url)), mode, ...(variant ? [variant] : [])], { cwd: fileURLToPath(new URL('../../', import.meta.url)), input: head ? JSON.stringify(head) : undefined, encoding: 'utf8' });
  const typed = run('capture');
  assert.equal(typed.status, 0, typed.stderr);
  const typedHead = JSON.parse(typed.stdout);
  assert.deepEqual(typedHead.image.frame.children[0].state.reception, { kind: 'receiving', contract: { position: 0 } });
  const resumed = run('restore', undefined, typedHead);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout), '2026-01-01T00:00:00.000Z');
  for (const variant of ['other', 'raw']) {
    const rejected = run('restore', variant, typedHead);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /contract/);
    assert.match(rejected.stderr, /callbacks:0/);
  }
  const raw = run('capture-raw');
  assert.equal(raw.status, 0, raw.stderr);
  const rawHead = JSON.parse(raw.stdout);
  assert.deepEqual(rawHead.image.frame.children[0].state.reception, { kind: 'receiving' });
  const rawResume = run('restore', 'raw', rawHead);
  assert.equal(rawResume.status, 0, rawResume.stderr);
  const relabel = run('restore', undefined, rawHead);
  assert.notEqual(relabel.status, 0);
  assert.match(relabel.stderr, /contract/);
  assert.match(relabel.stderr, /callbacks:0/);
});

for (const failure of ['encode', 'store']) {
  test(`${failure} failure after acceptance preserves its value and committed effect without authorizing another reception`, async () => {
    const effects = new Map();
    let callbacks = 0;
    let checked;
    let parentWork;
    let ref;
    const child = defineGroup()({ run: () => 'source' });
    const contract = reception(child, {
      check(value) {
        assert.equal(typeof value?.iso, 'string');
        return value;
      },
      encode(value) {
        if (failure === 'encode') throw new Error('fixture encode failure');
        return value.iso;
      },
      decode(value) {
        return { iso: value };
      },
    });
    const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { run: () => null } });
    const definition = defineScene()({
      members: [child],
      checkpoint: { receptions: [contract], key: 'reception-failure', version: 1, input: codec, output: codec, points: [point] },
      async run(work) {
        parentWork = work;
        const handle = work.children.create(child, null);
        ref = handle.ref;
        await handle.run();
        const value = { iso: '2026-01-01T00:00:00.000Z' };
        checked = await handle.accept(contract, () => {
          callbacks++;
          effects.set('fixed-position', value);
          return value;
        });
        assert.deepEqual(checked, value);
        assert.notEqual(checked, value);
        assert.equal(Object.isFrozen(checked), true);
        assert.throws(() => work.checkpoint({ point: point, state: null, refs: {} }), new RegExp(`fixture ${failure} failure`));
        await assert.rejects(
          handle.accept(contract, () => {
            callbacks++;
            return { iso: '2026-02-01T00:00:00.000Z' };
          }),
        );
        return null;
      },
    });
    const store = new MemoryCheckpointStore();
    if (failure === 'store')
      store.save = () => {
        throw new Error('fixture store failure');
      };
    const runtime = installCallable(definition, { providers: [], source: { capture: () => null }, checkpoints: { store } });
    await assert.rejects(runtime.run(null, {}), new RegExp(`fixture ${failure} failure`));
    assert.equal(callbacks, 1);
    assert.deepEqual(effects.get('fixed-position'), checked);
    assert.equal(parentWork.children.facts.get(ref).reception.status, 'accepted');
    assert.equal(parentWork.children.facts.accepted(ref, contract), checked);
  });
}
