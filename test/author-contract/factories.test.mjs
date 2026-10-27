import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineScene, defineGroup, defineNode, checkpointPoint } from '@capix/server-runtime';
import { MemoryCheckpointStore } from '@capix/checkpoint';
import { ResourceOffer } from '@capix/resources';

const metadata = { name: 'test', label: 'Test', source: 'test' };
const codec = { encode: (value) => value, decode: (value) => value };

test('actual factories preserve explicitly adapted inputs and function receivers without executing at definition time', async () => {
  let executions = 0;
  const resource = new ResourceOffer({ name: 'test.factory.value', expose: () => 4 });
  const run = {
    factor: 3,
    deps: { value: resource.request() },
    execute(work) {
      executions++;
      return work.input * this.factor + work.resources.value;
    },
  };
  const leaf = defineNode()({ ...metadata, deps: run.deps, run: run.execute.bind(run) });
  const second = defineNode()({ ...metadata, deps: run.deps, run: run.execute.bind(run) });
  assert.notEqual(leaf, second);
  assert.equal(executions, 0);
  const adaptation = {
    base: 2,
    prepare(input) {
      return input + this.base;
    },
  };
  adaptation.base = 3;
  const operation = defineGroup()({
    ...metadata,
    members: [leaf],
    deps: { value: resource.request() },
    async run(work) {
      const child = work.children.create(leaf, adaptation.prepare(work.input));
      await child.run();
      return child.accept();
    },
  });
  const execution = defineGroup()({
    members: [operation],
    deps: { value: resource.request() },
    async run(work) {
      const child = work.children.create(operation, work.input);
      await child.run();
      return child.accept();
    },
  });
  const root = defineScene()({
    members: [execution],
    deps: { value: resource.request() },
    async run(work) {
      const child = work.children.create(execution, work.input.number);
      await child.run();
      return child.accept();
    },
  });
  const runtime = installCallable(root, { providers: [resource.provide(() => null)], source: { runtime: () => null, capture: () => null } });
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
      run(_work, state) {
        return state;
      },
    },
  };
  const point = checkpointPoint()(pointContent);
  const root = defineScene()({
    checkpoint: { key: 'test.factory.cp', version: 1, input: codec, output: codec, points: [point] },
    run(work) {
      work.checkpoint?.({ point: point, state: work.input, refs: {} });
      return work.input;
    },
  });
  const store = new MemoryCheckpointStore();
  const runtime = installCallable(root, { providers: [], source: { runtime: () => null, capture: () => null }, checkpoints: { store } });
  assert.equal(await runtime.run('saved', {}), 'saved');
  assert.equal(pointContent.checks, 1);
  assert.equal(point.name, 'prepared');
});
