import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node, defineNode, defineGroup, reception, resolveDeclaration } from '@capix/server-runtime';

const metadata = { name: 'test', label: 'test', source: 'test', callee: 'local' };
const identity = { check: (value) => value, encode: (value) => value, decode: (value) => value };
function makeChild() {
  return defineNode()({ ...metadata, run: (work) => work.input });
}

function parent(children, receptions) {
  return defineGroup()({ ...metadata, members: children, receptions, run: (work) => work.input });
}

test('reception registration rejects repeated contracts and targets outside its direct children', () => {
  const child = makeChild();
  const accepted = reception(child, identity);
  const owner = parent([child], [accepted, accepted]);
  assert.throws(() => resolveDeclaration(owner), /Duplicate parent reception contract/);
  owner.receptions = [accepted];
  const snapshot = resolveDeclaration(owner).declaration.receptions[0];
  owner.receptions = [accepted, snapshot];
  assert.throws(() => resolveDeclaration(owner), /Duplicate parent reception contract/);
  const sameShapeChild = makeChild();
  assert.throws(() => resolveDeclaration(parent([sameShapeChild], [accepted])), /Reception targets a member outside its owner/);
  const nestedChild = makeChild();
  const nestedAccepted = reception(nestedChild, identity);
  const nested = parent([nestedChild], []);
  assert.throws(() => resolveDeclaration(parent([nested], [nestedAccepted])), /Reception targets a member outside its owner/);
});

test('separate contracts for one child remain legal without duplicating its parent ownership', () => {
  const child = makeChild();
  const first = reception(child, identity);
  const second = reception(child, identity);
  const resolved = resolveDeclaration(parent([child], [first, second]));
  assert.equal(resolved.declaration.receptions.length, 2);
  assert.equal(resolved.declaration.receptions[0].child, child);
  assert.equal(resolved.declaration.receptions[1].child, child);
  assert.throws(() => parent([child], [first]), /already belongs to another parent/);
});

for (const receptions of [[], [reception(makeChild(), identity)]]) {
  test(`A rejects a reception registry of size ${receptions.length} in class and factory forms`, () => {
    class InvalidLeaf extends Node {
      name = 'invalid';
      label = 'invalid';
      source = 'test';
      callee = 'local';
      receptions = receptions;
      deps = {};
      run = (work) => work.input;
    }
    assert.throws(() => resolveDeclaration(new InvalidLeaf()), /Nodes cannot declare receptions/);
    const factory = defineNode()({ ...metadata, receptions, run: (work) => work.input });
    assert.throws(() => resolveDeclaration(factory), /Nodes cannot declare receptions/);
  });
}

test('binding fixes validator and codec functions while preserving their original receiver', () => {
  const child = makeChild();
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
    const child = makeChild();
    const invalid = reception(child, { ...identity, [field]: undefined });
    assert.throws(() => resolveDeclaration(parent([child], [invalid])), /Reception needs check, encode and decode functions/);
  }
});
