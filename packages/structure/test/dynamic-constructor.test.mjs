import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Dynamic, Node, Group, Scene } from '@weiliang0121/capix-structure';

const finish = (value) => ({ kind: 'finish', value });

test('constructor Dynamic failure never claims a valid candidate or decision from a rejected batch', () => {
  const occupied = new Node({ run: () => 1 });
  new Group().add(occupied);
  const free = new Node({ run: () => 2 });
  const decision = new Node({ run: () => finish(1) });
  assert.throws(() => new Dynamic({ options: { free, occupied }, decide: decision }), /parent/);
  assert.deepEqual(new Group().add(free, decision).members, [free, decision]);
  const other = new Node({ run: () => 3 });
  assert.throws(() => new Dynamic({ options: { other }, decide: occupied }), /parent/);
  new Group().add(other);
  const invalidDecisionFree = new Node({ run: () => 4 });
  assert.throws(() => new Dynamic({ options: { free: invalidDecisionFree }, decide: new Scene() }), /Group or Node/);
  new Group().add(invalidDecisionFree);
});

test('constructor rejects invalid option descriptors and limits before claiming members', () => {
  for (const options of [Object.defineProperty({}, 'action', { get: () => assert.fail('getter must not execute') }), { [Symbol('action')]: new Node() }, { create: new Node() }, { '': new Node() }]) {
    const decision = new Node({ run: () => finish(0) });
    assert.throws(() => new Dynamic({ options, decide: decision }), /data properties|strings|reserved|empty/);
    new Group().add(decision);
  }
  const candidate = new Node({ run: () => 0 });
  const decision = new Node({ run: () => finish(0) });
  assert.throws(() => new Dynamic({ options: { candidate }, decide: decision, maxSteps: -1 }), RangeError);
  assert.throws(() => new Dynamic({ options: { candidate }, decide: decision, maxSteps: Infinity }), RangeError);
  new Group().add(candidate, decision);
});
