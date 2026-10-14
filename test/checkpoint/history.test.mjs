import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RuntimeDefinition, ExecutionDefinition, ExceptionContract, assembleRuntime, MemoryCheckpointStore, cloneCheckpointImage, DeclaredException } from '@capix/server-runtime';

const rejected = new ExceptionContract('fixture.rejected');
const codec = { encode: (value) => value, decode: (value) => value };
const source = { entry: () => null, capture: () => null };

function harness(store, resume, calls) {
  class Child extends ExecutionDefinition {
    raises = [rejected];
    checkpoint = { key: 'fixture.history.child', version: 1, input: codec, output: codec, points: {} };
    run = {
      requires: {},
      execute() {
        calls.child++;
        throw rejected.create('invalid first output', { source: 'model' });
      },
    };
  }
  const child = new Child();
  class Root extends RuntimeDefinition {
    children = [child];
    maxRounds = 2;
    checkpoint = { key: 'fixture.history.root', version: 1, input: codec, output: codec, points: { second: { state: codec, resume: { requires: {}, uses: [child], execute: (context, invocation, children) => resume(context, invocation, children, child) } } } };
    exceptions = {
      requires: {},
      accepts: [rejected],
      handle() {
        calls.handled++;
        return { kind: 'continue', input: { retry: true }, reason: 'one declared retry' };
      },
    };
    run = {
      requires: {},
      uses: [child],
      async execute(context, invocation, children) {
        if (context.progress.round === 1) return children.get(child).create(invocation, {}, { key: 'rejected' }).run();
        invocation.checkpoint.save('second', null);
        return 'second round result';
      },
    };
  }
  return assembleRuntime(new Root(), { source, providers: [], checkpoints: { store } });
}

async function capture() {
  const images = [];
  const memory = new MemoryCheckpointStore();
  const store = {
    read: (id) => memory.read(id),
    save: (image, revision) => {
      images.push(image);
      return memory.save(image, revision);
    },
    finish: (id, revision, delivery) => memory.finish(id, revision, delivery),
  };
  const calls = { child: 0, handled: 0 };
  const runtime = harness(store, () => assert.fail('original path cannot resume'), calls);
  assert.equal(await runtime.run({}, {}), 'second round result');
  assert.deepEqual(calls, { child: 1, handled: 1 });
  return images[0];
}

test('second-round checkpoints retain a handled child exception as inert historical facts', async () => {
  const image = await capture();
  const failed = image.frame.children[0];
  assert.equal(image.frame.round, 2);
  assert.equal(failed.round, 1);
  assert.equal(failed.state.kind, 'failed');
  assert.equal(failed.state.failure.kind, 'exception');
  assert.equal(failed.state.failure.contract, rejected.name);
  assert.equal(failed.state.error.message, 'invalid first output');
  assert.equal(failed.state.error instanceof Error, false);
  const store = new MemoryCheckpointStore();
  store.save(image, 0);
  const calls = { child: 0, handled: 0 };
  const restored = harness(
    store,
    (context, invocation) => {
      assert.equal(context.progress.round, 2);
      assert.deepEqual(context.currentInput, { retry: true });
      const relation = invocation.children.values()[0];
      assert.equal(relation.returned.status, 'failed');
      assert.equal(relation.returned.error instanceof DeclaredException, false);
      assert.equal(relation.invocation.context.status, 'failed');
      assert.equal(relation.invocation.failure.contract, rejected.name);
      invocation.checkpoint.save('second', null);
      return 'resumed second round';
    },
    calls,
  );
  assert.equal(await restored.resume(image.frame.owner.contextId, {}), 'resumed second round');
  assert.deepEqual(calls, { child: 0, handled: 0 });
  assert.deepEqual(store.read(image.frame.owner.contextId).image.frame.children[0], failed, 'recapture preserves the same diagnostic history');
});

test('a historical failed child is never a resumable delivery even with a matching declaration', async () => {
  const image = await capture();
  const store = new MemoryCheckpointStore();
  store.save(image, 0);
  const calls = { child: 0, handled: 0 };
  const restored = harness(store, (_context, invocation, children, child) => children.get(child).resume(invocation, image.frame.children[0].identity.contextId).run(), calls);
  await assert.rejects(restored.resume(image.frame.owner.contextId, {}), /Historical failed child cannot be resumed/);
  assert.deepEqual(calls, { child: 0, handled: 0 });
});

test('checkpoint validation rejects current-round, structural and misattributed failed history', async () => {
  const image = await capture();
  for (const alter of [
    (value) => {
      value.frame.children[0].round = 2;
    },
    (value) => {
      value.frame.children[0].state.failure.kind = 'error';
    },
    (value) => {
      value.frame.children[0].state.failure.contextId = 'other';
    },
    (value) => {
      delete value.frame.children[0].state.failure.contract;
    },
    (value) => {
      value.frame.children[0].state.failure.phase = 'control';
    },
  ]) {
    const changed = structuredClone(image);
    alter(changed);
    assert.throws(() => cloneCheckpointImage(changed), /historical child failure/);
  }
});
