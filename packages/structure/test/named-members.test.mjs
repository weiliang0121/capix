import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node, Group } from '@weiliang0121/capix-structure';

test('alias registration is atomic and rejects reserved names, conflicting aliases and cycles', () => {
  const primary = new Node({ run: () => 1 });
  const replacement = new Node({ run: () => 2 });
  const fresh = new Node({ run: () => 3 });
  const group = new Group().add({ primary });
  assert.equal(group.add({ primary }), group);
  assert.deepEqual(group.members, [primary]);
  assert.throws(() => group.add({ fresh, primary: replacement }), /already belongs/);
  assert.deepEqual(group.names, { primary });
  assert.deepEqual(group.members, [primary]);
  assert.doesNotThrow(() => new Group().add(fresh, replacement));
  for (const name of ['create', 'invoke', 'open', 'facts', 'resume', 'constructor', '__proto__', 'toString', '']) {
    const node = new Node({ run: () => 0 });
    assert.throws(() => group.add({ [name]: node }), /reserved|empty/);
    assert.doesNotThrow(() => new Group().add(node));
  }
  const symbolNode = new Node({ run: () => 0 });
  assert.throws(() => group.add({ [Symbol('node')]: symbolNode }), /strings/);
  assert.doesNotThrow(() => new Group().add(symbolNode));
  const child = new Group();
  group.add({ child });
  assert.throws(() => child.add({ group }), /Cyclic/);
  assert.deepEqual(child.names, {});
});
