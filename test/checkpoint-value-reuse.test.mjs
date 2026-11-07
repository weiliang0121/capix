import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHECKPOINT_MAX_BYTES, cloneCheckpointValue, cloneCheckpointImage, checkpointSaveReceipt } from '@capix/checkpoint';

function nested(value, levels) {
  let result = value;
  for (let index = 0; index < levels; index++) result = { child: result };
  return result;
}

function image(children = []) {
  return { id: 'value-reuse-image', formatVersion: 5, contract: { key: 'value-reuse', version: 1 }, point: 'saved', frame: { owner: { contextId: 'parent', kind: 'group' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: children.length, children }, state: null, references: {} };
}

function child() {
  return { identity: { contextId: 'child', parentContextId: 'parent', kind: 'node' }, target: { position: 0 }, round: 1, order: 0, input: null, state: { kind: 'returned', output: { text: 'answer' }, progress: { round: 1, phase: 'execute', currentInput: null }, reception: { kind: 'pending' } } };
}

test('only CP-owned fixed roots are reused; raw business values stay independent', () => {
  const raw = { text: 'first', nested: { value: 1 } };
  const fixed = cloneCheckpointValue(raw);
  assert.notEqual(fixed, raw);
  assert.equal(cloneCheckpointValue(fixed), fixed);
  const composed = cloneCheckpointValue({ one: fixed, two: fixed });
  assert.equal(composed.one, fixed);
  assert.equal(composed.two, fixed);
  assert.ok(Object.isFrozen(composed));
  assert.ok(Object.isFrozen(fixed.nested));
  raw.nested.value = 2;
  assert.equal(cloneCheckpointValue(raw).nested.value, 2);
  assert.equal(fixed.nested.value, 1);
  const frozenByCaller = Object.freeze({ nested: Object.freeze({ value: 3 }) });
  assert.notEqual(cloneCheckpointValue(frozenByCaller), frozenByCaller);
  const decoded = JSON.parse(JSON.stringify(fixed));
  assert.notEqual(cloneCheckpointValue(decoded), decoded);
});

test('a proxy around a certified root does not inherit its private proof', () => {
  const fixed = cloneCheckpointValue({ value: 'fixed' });
  const proxy = Proxy.revocable(fixed, {});
  const copied = cloneCheckpointValue(proxy.proxy);
  assert.notEqual(copied, proxy.proxy);
  assert.notEqual(copied, fixed);
  assert.deepEqual(copied, fixed);
  proxy.revoke();
  assert.throws(() => cloneCheckpointValue(proxy.proxy), TypeError);
  assert.equal(cloneCheckpointValue(fixed), fixed);
});

test('a failed copy grants no proof to raw inputs or their partial subtrees', () => {
  const raw = { nested: { value: 'before' }, unsupported: () => {} };
  assert.throws(() => cloneCheckpointValue(raw), /only finite JSON data/);
  delete raw.unsupported;
  raw.nested.value = 'after';
  const fixed = cloneCheckpointValue(raw);
  assert.notEqual(fixed.nested, raw.nested);
  assert.equal(fixed.nested.value, 'after');
  raw.nested.value = 'later';
  assert.equal(fixed.nested.value, 'after');

  let read = false;
  const accessor = Object.freeze({
    get value() {
      read = true;
      return fixed;
    },
  });
  assert.throws(() => cloneCheckpointValue(accessor), /accessor/);
  assert.equal(read, false);
  const cycle = { fixed };
  cycle.self = cycle;
  assert.throws(() => cloneCheckpointValue(cycle), /cyclic/);
});

test('certified roots carry relative depth into enclosing values', () => {
  const maximum = cloneCheckpointValue(nested(null, 64));
  assert.equal(cloneCheckpointValue(maximum), maximum);
  assert.throws(() => cloneCheckpointValue({ child: maximum }), /structure limit/);
  const part = cloneCheckpointValue(nested(null, 10));
  assert.doesNotThrow(() => cloneCheckpointValue(nested(part, 54)));
  assert.throws(() => cloneCheckpointValue(nested(part, 55)), /structure limit/);
  assert.throws(() => cloneCheckpointValue(nested(null, 65)), /structure limit/);
});

test('certified node counts charge every occurrence and the enclosing root', () => {
  const maximum = cloneCheckpointValue(Array(99999).fill(null));
  assert.equal(cloneCheckpointValue(maximum), maximum);
  assert.throws(() => cloneCheckpointValue({ child: maximum }), /structure limit/);
  const half = cloneCheckpointValue(Array(49999).fill(0));
  const less = cloneCheckpointValue(Array(49998).fill(0));
  assert.doesNotThrow(() => cloneCheckpointValue([half, less]));
  assert.throws(() => cloneCheckpointValue([half, half]), /structure limit/);
});

test('certified byte counts include property keys and every repeated reference', () => {
  const key = 'k'.repeat(CHECKPOINT_MAX_BYTES / 2);
  const part = cloneCheckpointValue({ [key]: 0 });
  assert.equal(cloneCheckpointValue(part), part);
  assert.throws(() => cloneCheckpointValue([part, part]), /byte limit/);
  const unicode = cloneCheckpointValue({ text: '字'.repeat(1024 * 1024) });
  assert.doesNotThrow(() => cloneCheckpointValue([unicode, unicode]));
  assert.throws(() => cloneCheckpointValue([unicode, unicode, unicode]), /byte limit/);
});

test('encoded JSON budget is still checked after reusing valid subtrees', () => {
  // The traversal estimate is below 8 MiB, but JSON escapes each backslash.
  const part = cloneCheckpointValue({ text: '\\'.repeat((9 * 1024 * 1024) / 4) });
  assert.throws(() => cloneCheckpointValue([part, part]), /encoded byte limit/);
});

test('pure-value proof cannot substitute for complete Frame relationship checks', () => {
  const fixedChild = cloneCheckpointValue(child());
  const valid = cloneCheckpointImage(image([fixedChild]));
  assert.equal(valid.frame.children[0], fixedChild);
  assert.throws(() => cloneCheckpointImage(image([fixedChild, fixedChild])), /invalid child identity/);
  const wrongParent = cloneCheckpointValue({ ...fixedChild, identity: { ...fixedChild.identity, parentContextId: 'other' } });
  assert.throws(() => cloneCheckpointImage(image([wrongParent])), /invalid child identity/);
  const wrongRefs = cloneCheckpointValue({ ...image([fixedChild]), references: { selected: { contextId: 'missing', parentContextId: 'parent', parentRound: 1, order: 0, target: { position: 0 } } } });
  assert.throws(() => cloneCheckpointImage(wrongRefs), /reference differs/);
  const noContinuation = cloneCheckpointValue({ ...valid, id: 'next', frame: { ...valid.frame, round: 2 } });
  assert.throws(() => cloneCheckpointImage(noContinuation), /second round requires/);
});

test('raw and certified compositions produce the same encoded image and receipt', () => {
  for (let index = 0; index < 32; index++) {
    const raw = { content: `文字\\\n${index}`, numbers: [null, true, -0, index], nested: nested({ content: 'fixed' }, index), names: JSON.parse('{"__proto__":{"safe":true},"constructor":"data"}') };
    const fixed = cloneCheckpointValue(raw);
    const complete = cloneCheckpointImage({ ...image(), state: { first: raw, second: raw } });
    const reused = cloneCheckpointImage({ ...image(), state: { first: fixed, second: fixed } });
    assert.deepEqual(reused, complete);
    assert.equal(JSON.stringify(reused), JSON.stringify(complete));
    assert.deepEqual(checkpointSaveReceipt(reused, 1), checkpointSaveReceipt(complete, 1));
  }
});
