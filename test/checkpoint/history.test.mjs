import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, ExceptionContract, MemoryCheckpointStore, cloneCheckpointImage, DeclaredException, reception as defineReception } from '@capix/server-runtime';

const rejected = new ExceptionContract('fixture.rejected');
const codec = { encode: (value) => value, decode: (value) => value };
const source = { entry: () => null, capture: () => null };

function harness(store, resume, calls, reception = false) {
  class Child extends Group {
    raises = [rejected];
    checkpoint = { key: 'fixture.history.child', version: 1, input: codec, output: codec, points: [] };
    run = {
      requires: {},
      execute() {
        calls.child++;
        if (reception) return { answer: 'successful child output' };
        throw rejected.create('invalid first output', { source: 'model' });
      },
    };
  }
  const child = new Child();
  const contract = defineReception(child, { check: (value) => value, encode: codec.encode, decode: codec.decode });
  class Root extends Scene {
    members = [child];
    receptions = reception === 'typed' ? [contract] : [];
    raises = [rejected];
    maxRounds = 2;
    checkpoint = { key: 'fixture.history.root', version: 1, input: codec, output: codec, points: [{ name: 'second', state: codec, references: {}, resume: { requires: {}, uses: [child], execute: (work) => resume(work, child, this.checkpoint.points[0]) } }] };
    exceptions = {
      requires: {},
      accepts: [rejected],
      handle(work) {
        calls.handled++;
        return work.continue({ retry: true }, 'one declared retry');
      },
    };
    run = {
      requires: {},
      uses: [child],
      execute: async (work) => {
        if (work.round === 1) {
          const call = work.children.create(child, {}, { key: 'rejected' });
          const output = await call.run();
          if (reception) {
            const receive = () => {
              throw rejected.create('parent refused successful output', { source: 'acceptance' });
            };
            return reception === 'typed' ? call.accept(contract, receive) : call.accept(receive);
          }
          return output;
        }
        work.checkpoint.save(this.checkpoint.points[0], null, {});
        return 'second round result';
      },
    };
  }
  return installCallable(new Root(), { source, providers: [], checkpoints: { store } });
}

async function capture(reception = false) {
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
  const runtime = harness(store, () => assert.fail('original path cannot resume'), calls, reception);
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
    (work, child, point) => {
      assert.equal(work.round, 2);
      assert.deepEqual(work.input, { retry: true });
      const relation = work.children.facts.values()[0];
      assert.equal(relation.returned.status, 'failed');
      assert.equal(relation.returned.diagnostic instanceof DeclaredException, false);
      assert.deepEqual(relation.returned.diagnostic, failed.state.error);
      assert.equal(relation.returned.failure.contract, rejected.name);
      work.checkpoint.save(point, null, {});
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
  const restored = harness(store, (work, child) => work.children.resume(work.children.facts.requireUnique(child, { parentRound: 1 }).ref).run(), calls);
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

for (const mode of [true, 'typed'])
  test(`real ${mode === 'typed' ? 'typed' : 'raw'} handled reception continuation retains successful child output and readonly diagnostic through recapture`, async () => {
    const image = await capture(mode);
    const child = image.frame.children[0];
    assert.equal(image.frame.continuation.origin.kind, 'child-reception');
    assert.equal(child.state.kind, 'returned');
    assert.equal(child.state.reception.kind, 'failed');
    assert.deepEqual(child.state.reception.contract, mode === 'typed' ? { position: 0 } : undefined);
    assert.deepEqual(child.state.output, { answer: 'successful child output' });
    assert.equal(child.state.reception.error.message, 'parent refused successful output');
    const store = new MemoryCheckpointStore();
    store.save(image, 0);
    const calls = { child: 0, handled: 0 };
    const runtime = harness(
      store,
      (work, definition, point) => {
        const fact = work.children.facts.requireUnique(definition, { parentRound: 1 });
        assert.equal(work.continuation.origin.kind, 'child-reception');
        assert.equal(work.continuation.origin.child, fact.ref);
        assert.equal(fact.returned.status, 'succeeded');
        assert.deepEqual(fact.returned.output, { answer: 'successful child output' });
        assert.equal(fact.reception.status, 'failed');
        assert.equal(fact.reception.diagnostic instanceof DeclaredException, false);
        assert.deepEqual(fact.reception.diagnostic, child.state.reception.error);
        work.checkpoint.save(point, null, {});
        return 'continued after prior reception failure';
      },
      calls,
      mode,
    );
    assert.equal(await runtime.resume(image.frame.owner.contextId, {}), 'continued after prior reception failure');
    assert.deepEqual(calls, { child: 0, handled: 0 });
    assert.deepEqual(store.read(image.frame.owner.contextId).image.frame.children[0], child);
  });
