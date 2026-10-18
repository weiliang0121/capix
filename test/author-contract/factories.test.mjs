import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineRuntime, defineExecution, defineOperation, defineAttempt, defineChildEntry, checkpointPoint, ResourceOffer, MemoryCheckpointStore, assembleRuntime } from '@capix/server-runtime';

const metadata = { name: 'test', label: 'Test', source: 'test', callee: 'test' };
const codec = { encode: (value) => value, decode: (value) => value };

test('actual factories bind R/E/O/A, preserve alternate input and function receivers without executing at definition time', async () => {
  let executions = 0;
  const resource = new ResourceOffer('test.factory.value', () => 4);
  const run = {
    factor: 3,
    requires: { value: resource.request() },
    execute(work) {
      executions++;
      return work.input * this.factor + work.resources.value;
    },
  };
  const leaf = defineAttempt()({ ...metadata, run });
  const second = defineAttempt()({ ...metadata, run });
  assert.notEqual(leaf, second);
  assert.equal(executions, 0);
  const entryContent = {
    base: 2,
    accept({ input }) {
      return input + this.base;
    },
  };
  const entry = defineChildEntry(leaf, entryContent);
  assert.ok(Object.isFrozen(entry));
  assert.equal(Object.isFrozen(entryContent), false);
  assert.throws(() => {
    entry.definition = second;
  }, TypeError);
  assert.throws(() => {
    entry.accept = () => 0;
  }, TypeError);
  entryContent.base = 3;
  const operation = defineOperation()({
    ...metadata,
    children: [leaf],
    run: {
      requires: { value: resource.request() },
      async execute(work) {
        const child = work.children.entry(entry, work.input);
        await child.run();
        return child.accept();
      },
    },
  });
  const execution = defineExecution()({
    children: [operation],
    run: {
      requires: { value: resource.request() },
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
      requires: { value: resource.request() },
      async execute(work) {
        const child = work.children.create(execution, work.input.number);
        await child.run();
        return child.accept();
      },
    },
  });
  const runtime = assembleRuntime(root, { providers: [resource.provide(() => null)], source: { runtime: () => null, capture: () => null } });
  assert.equal(await runtime.run({ number: 5 }, {}), 28);
  assert.equal(executions, 1);
});

test('point factories retain real identity and save optional typed checkpoints in actual work', async () => {
  const pointContent = {
    name: 'prepared',
    state: codec,
    references: {},
    checks: 0,
    check() {
      this.checks++;
    },
    resume: {
      execute(_work, state) {
        return state;
      },
    },
  };
  const point = checkpointPoint()(pointContent);
  const root = defineRuntime()({
    checkpoint: { key: 'test.factory.cp', version: 1, input: codec, output: codec, points: [point] },
    run: {
      execute(work) {
        work.checkpoint?.save(point, work.input, {});
        return work.input;
      },
    },
  });
  const store = new MemoryCheckpointStore();
  const runtime = assembleRuntime(root, { providers: [], source: { runtime: () => null, capture: () => null }, checkpoints: { store } });
  assert.equal(await runtime.run('saved', {}), 'saved');
  assert.equal(pointContent.checks, 1);
  assert.equal(point.name, 'prepared');
});
