import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, Node } from '@weiliang0121/capix-structure';

test('add rejects invalid membership and cycles without partially installing an argument list', () => {
  const node = new Node({ run: () => null });
  const scene = new Scene({ run: () => null });
  const group = new Group({ run: () => null });
  assert.equal(node.add, undefined);
  assert.throws(() => group.add(node, scene), /member|kind|scene/i);
  assert.deepEqual(group.members, []);
  assert.throws(() => group.add(group), /cyclic|cycle|itself/i);
  const child = new Group({ run: () => null });
  group.add(child);
  assert.throws(() => child.add(group), /cyclic|cycle/i);
  assert.deepEqual(child.members, []);
});

test('a member has one structural parent and a failed batch claims none of its free members', () => {
  const member = new Node({ run: () => null });
  const free = new Node({ run: () => null });
  const first = new Group({ run: () => null });
  const second = new Group({ run: () => null });
  first.add(member, member);
  first.add(member);
  assert.deepEqual(first.members, [member]);
  assert.throws(() => second.add(free, member), /parent/i);
  assert.deepEqual(second.members, []);
  const third = new Group({ run: () => null });
  third.add(free);
  assert.deepEqual(third.members, [free]);
  assert.throws(() => {
    second.members = [member];
  }, TypeError);
});

test('a nested group cannot acquire another parent while its member ownership stays intact', () => {
  const node = new Node({ run: () => null });
  const nested = new Group({ run: () => null });
  nested.add(node);
  const scene = new Scene({ run: () => null });
  scene.add(nested);
  const other = new Scene({ run: () => null });
  assert.throws(() => other.add(nested), /parent/i);
  assert.throws(() => other.add(node), /parent/i);
  assert.deepEqual(scene.members, [nested]);
  assert.deepEqual(nested.members, [node]);
  assert.deepEqual(other.members, []);
});
