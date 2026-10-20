import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { cloneCheckpointImage, checkpointReference, defineScene, defineGroup, reception, checkpointPoint, MemoryCheckpointStore } from '@capix/server-runtime';
import { decodeCheckpointFrame } from '@capix/server-runtime/construction';

const codec = { encode: (value) => value, decode: (value) => value };
const dateBinding = { position: 0, childPosition: 0, check: (value) => assert.ok(value instanceof Date && Number.isFinite(value.getTime())), codec: { encode: (value) => value.toISOString(), decode: (value) => new Date(value) } };
function image(reception = { kind: 'accepted', contract: { position: 0 }, output: '2026-01-01T00:00:00.000Z' }) {
  const child = { identity: { contextId: 'child', parentContextId: 'parent', kind: 'group' }, target: { position: 0 }, round: 1, order: 0, input: null, state: { kind: 'returned', output: 'raw', progress: { round: 1, currentInput: null, phase: 'receive' }, reception } };
  return { id: 'typed', formatVersion: 4, contract: { key: 'parent', version: 1 }, point: 'saved', frame: { owner: { contextId: 'parent', kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 1, children: [child] }, state: null, references: { selected: checkpointReference(child) } };
}
const decode = (source, bindings = [dateBinding]) => decodeCheckpointFrame(cloneCheckpointImage(source).frame, { input: codec, output: codec }, [{ kind: 'group' }], bindings);

for (const kind of ['receiving', 'accepted', 'failed']) {
  test(`v4 retains the parent reception position for ${kind}`, () => {
    const source = image(kind === 'accepted' ? undefined : { kind, contract: { position: 0 } });
    if (kind === 'failed') {
      source.frame.children[0].state.reception.error = { code: 'REJECTED', message: 'business refusal' };
      source.frame.children[0].state.reception.failure = { kind: 'exception', phase: 'execute', contextId: 'parent', contract: 'refused' };
      source.frame.round = 2;
      source.frame.continuation = { fromRound: 1, stage: 'handling', reason: 'try another result', origin: { kind: 'child-reception', child: checkpointReference(source.frame.children[0]) } };
    }
    const decoded = decode(source);
    assert.deepEqual(decoded.children[0].state.reception.contract, { position: 0 });
    if (kind === 'accepted') assert.ok(decoded.children[0].state.reception.output instanceof Date);
    else assert.equal(Object.hasOwn(decoded.children[0].state.reception, 'output'), false);
  });
}

test('typed undefined has explicit encoding while legacy raw undefined remains untagged', () => {
  const binding = {
    position: 0,
    childPosition: 0,
    check: (value) => assert.equal(value, undefined),
    codec: {
      encode: () => null,
      decode: (value) => {
        assert.equal(value, null);
        return undefined;
      },
    },
  };
  const decoded = decode(image({ kind: 'accepted', contract: { position: 0 }, output: null }), [binding]);
  const reception = decoded.children[0].state.reception;
  assert.equal(Object.hasOwn(reception, 'output'), true);
  assert.equal(reception.output, undefined);
  const raw = decode(image({ kind: 'accepted' }), []);
  assert.equal(Object.hasOwn(raw.children[0].state.reception, 'contract'), false);
  assert.equal(raw.children[0].state.reception.output, undefined);
  assert.throws(() => decode(image({ kind: 'accepted', contract: { position: 0 } }), [binding]), /requires encoded output/);
});

test('decoding rejects unregistered reception positions, other child declarations and invalid decoded values', () => {
  assert.throws(() => decode(image(), []), /reception contract position/);
  assert.throws(() => decode(image(), [{ ...dateBinding, position: 1 }]), /reception contract position/);
  assert.throws(() => decode(image(), [{ ...dateBinding, childPosition: 1 }]), /child declaration/);
  assert.throws(() => decode(image(), [{ ...dateBinding, codec: { ...dateBinding.codec, decode: () => 'not a Date' } }]), /assertion|instanceof/i);
  assert.throws(
    () =>
      decode(image(), [
        {
          ...dateBinding,
          codec: {
            ...dateBinding.codec,
            decode: () => {
              throw new Error('rejected encoding');
            },
          },
        },
      ]),
    /rejected encoding/,
  );
  for (const contract of [{ position: -1 }, { position: 0, codec: 'guessed' }, {}, null]) assert.throws(() => cloneCheckpointImage(image({ kind: 'accepted', contract, output: null })), /Invalid checkpoint/);
  assert.throws(() => cloneCheckpointImage(image({ kind: 'pending', contract: { position: 0 } })), /reception contract position/);
});

function processFixture(mode, variant, head) {
  return spawnSync(process.execPath, ['test/checkpoint/fixtures/reception.mjs', mode, ...(variant ? [variant] : [])], { cwd: process.cwd(), input: head ? JSON.stringify(head) : undefined, encoding: 'utf8' });
}

test('typed reception restores Date and undefined in a new process without re-running children or reception callbacks', () => {
  const captured = processFixture('capture');
  assert.equal(captured.status, 0, captured.stderr);
  const head = JSON.parse(captured.stdout);
  assert.equal(head.image.formatVersion, 4);
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
  const run = (mode, variant, head) => spawnSync(process.execPath, ['test/checkpoint/fixtures/receiving.mjs', mode, ...(variant ? [variant] : [])], { cwd: process.cwd(), input: head ? JSON.stringify(head) : undefined, encoding: 'utf8' });
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
    const child = defineGroup()({ run: { execute: () => 'source' } });
    const contract = reception(child, {
      check(value) {
        assert.ok(value instanceof Date);
        return value;
      },
      encode(value) {
        if (failure === 'encode') throw new Error('fixture encode failure');
        return value.toISOString();
      },
      decode(value) {
        return new Date(value);
      },
    });
    const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { execute: () => null } });
    const definition = defineScene()({
      members: [child],
      receptions: [contract],
      checkpoint: { key: 'reception-failure', version: 1, input: codec, output: codec, points: [point] },
      run: {
        async execute(work) {
          parentWork = work;
          const handle = work.children.create(child, null);
          ref = handle.ref;
          await handle.run();
          const value = new Date('2026-01-01T00:00:00.000Z');
          checked = await handle.accept(contract, () => {
            callbacks++;
            effects.set('fixed-position', value);
            return value;
          });
          assert.equal(checked, value);
          assert.throws(() => work.checkpoint.save(point, null, {}), new RegExp(`fixture ${failure} failure`));
          await assert.rejects(
            handle.accept(contract, () => {
              callbacks++;
              return new Date();
            }),
          );
          return null;
        },
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
    assert.equal(effects.get('fixed-position'), checked);
    assert.equal(parentWork.children.facts.get(ref).reception.status, 'accepted');
    assert.equal(parentWork.children.facts.accepted(ref, contract), checked);
  });
}
