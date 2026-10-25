import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Node, defineNode, defineGroup, defineScene } from '@capix/server-runtime';

const metadata = { name: 'test', label: 'test', source: 'test', callee: 'test' };
function assemble(leaf) {
  const operation = defineGroup()({
    ...metadata,
    members: [leaf],
    async run(work) {
      const child = work.children.create(leaf, work.input);
      await child.run();
      return child.accept();
    },
  });
  const execution = defineGroup()({
    members: [operation],
    async run(work) {
      const child = work.children.create(operation, work.input);
      await child.run();
      return child.accept();
    },
  });
  const root = defineScene()({
    members: [execution],
    async run(work) {
      const child = work.children.create(execution, work.input);
      await child.run();
      return child.accept();
    },
  });
  return installCallable(root, { providers: [], source: { runtime: () => null, capture: () => null } });
}

for (const children of [[], [defineNode()({ ...metadata, run: (work) => work.input })]]) {
  test(`binding rejects an A with ${children.length} declared children before any work runs`, () => {
    let called = 0;
    class InvalidLeaf extends Node {
      name = 'invalid';
      label = 'invalid';
      source = 'test';
      callee = 'local';
      members = children;
      deps = {};
      run = () => ++called;
    }
    assert.throws(() => assemble(new InvalidLeaf()), /Nodes cannot declare members/);
    assert.throws(() => defineNode()({ ...metadata, members: children, run: () => ++called }), /Node cannot have members/);
    assert.equal(called, 0);
  });
}

test('a class and its complete factory path retain the receiver and original output reference without recording', async () => {
  class Reader extends Node {
    name = 'read';
    label = 'read';
    source = 'test';
    callee = 'local';
    outputValue = { content: 'original' };
    deps = {};
    run = () => this.outputValue;
  }
  const reader = new Reader();
  const runtime = assemble(reader);
  const original = reader.outputValue;
  assert.equal(await runtime.run({}, {}), original);
  assert.equal(Object.isFrozen(reader), false);
  reader.outputValue = { content: 'next' };
  assert.equal(await runtime.run({}, {}), reader.outputValue);
});
