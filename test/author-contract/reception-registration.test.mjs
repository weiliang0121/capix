import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttemptDefinition, defineAttempt, defineOperation, reception, resolveDeclaration } from '@capix/server-runtime';

const metadata = { name: 'test', label: 'test', source: 'test', callee: 'local' };
const identity = { check: (value) => value, encode: (value) => value, decode: (value) => value };
const child = defineAttempt()({ ...metadata, run: { execute: (work) => work.input } });

function parent(children, receptions) {
  return defineOperation()({ ...metadata, children, receptions, run: { execute: (work) => work.input } });
}

test('reception registration rejects repeated contracts and targets outside its direct children', () => {
  const accepted = reception(child, identity);
  assert.throws(() => resolveDeclaration(parent([child], [accepted, accepted])), /Duplicate parent reception contract/);
  const snapshot = resolveDeclaration(parent([child], [accepted])).declaration.receptions[0];
  assert.throws(() => resolveDeclaration(parent([child], [accepted, snapshot])), /Duplicate parent reception contract/);
  const sameShapeChild = defineAttempt()({ ...metadata, run: { execute: (work) => work.input } });
  assert.throws(() => resolveDeclaration(parent([sameShapeChild], [accepted])), /Reception targets a child outside its owner/);
  const nested = parent([child], []);
  assert.throws(() => resolveDeclaration(parent([nested], [accepted])), /Reception targets a child outside its owner/);
});

test('separate contracts for one child and the same contract in separate parents remain legal', () => {
  const first = reception(child, identity);
  const second = reception(child, identity);
  const resolved = resolveDeclaration(parent([child], [first, second]));
  assert.equal(resolved.declaration.receptions.length, 2);
  assert.equal(resolved.declaration.receptions[0].child, child);
  assert.equal(resolved.declaration.receptions[1].child, child);
  assert.doesNotThrow(() => resolveDeclaration(parent([child], [first])));
});

for (const receptions of [[], [reception(child, identity)]]) {
  test(`A rejects a reception registry of size ${receptions.length} in class and factory forms`, () => {
    class InvalidLeaf extends AttemptDefinition {
      name = 'invalid';
      label = 'invalid';
      source = 'test';
      callee = 'local';
      receptions = receptions;
      run = { requires: {}, execute: (work) => work.input };
    }
    assert.throws(() => resolveDeclaration(new InvalidLeaf()), /Attempts cannot declare receptions/);
    const factory = defineAttempt()({ ...metadata, receptions, run: { execute: (work) => work.input } });
    assert.throws(() => resolveDeclaration(factory), /Attempts cannot declare receptions/);
  });
}

test('binding fixes validator and codec functions while preserving their original receiver', () => {
  const calls = [];
  const value = {
    label: 'receiver',
    check(input) {
      calls.push(`check:${this.label}`);
      return { ...input };
    },
    encode(input) {
      calls.push(`encode:${this.label}`);
      return input;
    },
    decode(input) {
      calls.push(`decode:${this.label}`);
      return input;
    },
  };
  const accepted = reception(child, value);
  const source = parent([child], [accepted]);
  const fixed = resolveDeclaration(source).declaration.receptions[0];
  value.check = () => assert.fail('modified check must not replace installed function');
  value.encode = () => assert.fail('modified encode must not replace installed function');
  value.decode = () => assert.fail('modified decode must not replace installed function');
  source.receptions = [];
  const input = { result: 1 };
  assert.deepEqual(fixed.value.check(input), input);
  assert.equal(fixed.value.encode(input), input);
  assert.equal(fixed.value.decode(input), input);
  assert.deepEqual(calls, ['check:receiver', 'encode:receiver', 'decode:receiver']);
  assert.equal(Object.isFrozen(fixed), true);
  assert.equal(Object.isFrozen(fixed.value), true);
  assert.equal(Object.isFrozen(value), false);
});

test('invalid reception value contracts are rejected during binding', () => {
  for (const field of ['check', 'encode', 'decode']) {
    const invalid = reception(child, { ...identity, [field]: undefined });
    assert.throws(() => resolveDeclaration(parent([child], [invalid])), /Reception requires check, encode and decode functions/);
  }
});
