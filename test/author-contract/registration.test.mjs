import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AttemptDefinition, defineAttempt, defineOperation, defineExecution, defineRuntime, assembleRuntime } from '@capix/server-runtime';

const metadata = { name: 'test', label: 'test', source: 'test', callee: 'test' };
function assemble(leaf) {
  const operation = defineOperation()({
    ...metadata,
    children: [leaf],
    run: {
      async execute(work) {
        const child = work.children.create(leaf, work.input);
        await child.run();
        return child.accept();
      },
    },
  });
  const execution = defineExecution()({
    children: [operation],
    run: {
      async execute(work) {
        const child = work.children.create(operation, work.input);
        await child.run();
        return child.accept();
      },
    },
  });
  const root = defineRuntime()({
    children: [execution],
    run: {
      async execute(work) {
        const child = work.children.create(execution, work.input);
        await child.run();
        return child.accept();
      },
    },
  });
  return assembleRuntime(root, { providers: [], source: { runtime: () => null, capture: () => null } });
}

for (const children of [[], [defineAttempt()({ ...metadata, run: { execute: (work) => work.input } })]]) {
  test(`binding rejects an A with ${children.length} declared children before any work runs`, () => {
    let called = 0;
    class InvalidLeaf extends AttemptDefinition {
      name = 'invalid';
      label = 'invalid';
      source = 'test';
      callee = 'local';
      children = children;
      run = { requires: {}, execute: () => ++called };
    }
    assert.throws(() => assemble(new InvalidLeaf()), /Attempts cannot declare children/);
    const literal = defineAttempt()({ ...metadata, children, run: { execute: () => ++called } });
    assert.throws(() => assemble(literal), /Attempts cannot declare children/);
    assert.equal(called, 0);
  });
}

test('a class and its complete factory path retain the receiver and original output reference without recording', async () => {
  class Reader extends AttemptDefinition {
    name = 'read';
    label = 'read';
    source = 'test';
    callee = 'local';
    outputValue = { content: 'original' };
    run = { requires: {}, execute: () => this.outputValue };
  }
  const reader = new Reader();
  const runtime = assemble(reader);
  const original = reader.outputValue;
  assert.equal(await runtime.run({}, {}), original);
  assert.equal(Object.isFrozen(reader), false);
  reader.outputValue = { content: 'next' };
  assert.equal(await runtime.run({}, {}), reader.outputValue);
});
