import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, Group, MemoryCheckpointStore, cloneCheckpointHead, cloneCheckpointImage, cloneCheckpointDelivery, CHECKPOINT_MAX_BYTES } from '@capix/server-runtime';

const codec = { encode: (value) => value, decode: (value) => value };
const source = { entry: () => null, capture: () => null };

function checkpoint(key, execute, uses = []) {
  return { key, version: 1, input: codec, output: codec, points: [{ name: 'saved', state: codec, references: {}, resume: { requires: {}, uses, execute } }] };
}

function savedRoot(children) {
  return { id: 'root-cp', formatVersion: 4, contract: { key: 'root', version: 1 }, point: 'saved', frame: { owner: { contextId: 'root-context', kind: 'scene' }, round: 1, phase: 'execute', input: {}, currentInput: {}, nextChildOrder: children.length, children }, state: null, references: {} };
}

function returnedChild() {
  return { target: { position: 0 }, identity: { contextId: 'child-context', parentContextId: 'root-context', kind: 'group' }, contract: { key: 'child-a', version: 1 }, round: 1, order: 0, key: 'work', input: {}, state: { kind: 'returned', output: 'delivered', progress: { round: 1, phase: 'receive', currentInput: {} }, reception: { kind: 'pending' } } };
}

test('terminal checkpoint persistence failure still delivers the owned child error to its parent', async () => {
  const memory = new MemoryCheckpointStore();
  const store = {
    read: (id) => memory.read(id),
    save: (image, revision) => memory.save(image, revision),
    finish: () => {
      throw new Error('database unavailable');
    },
  };
  let returned;
  class Child extends Group {
    checkpoint = checkpoint('child', () => assert.fail('not resuming'));
    run = {
      requires: {},
      execute: (work) => {
        work.checkpoint.save(this.checkpoint.points[0], null, {});
        return 'result';
      },
    };
  }
  const child = new Child();
  class Root extends Scene {
    members = [child];
    run = {
      requires: {},
      uses: [child],
      async execute(work) {
        const call = work.children.create(child, {});
        try {
          await call.run();
        } catch {
          /* A declaration cannot clear a structural child failure. */
        }
        returned = work.children.facts.values()[0].returned;
        return 'must not succeed';
      },
    };
  }
  const runtime = installCallable(new Root(), { source, providers: [], checkpoints: { store } });
  await assert.rejects(runtime.run({}, {}), /checkpoint|database/);
  assert.equal(returned.status, 'failed');
  assert.equal(runtime.running, false);
});

test('a cached resumed child cannot be reused through a different declaration contract', async () => {
  class ChildA extends Group {
    checkpoint = checkpoint('child-a', () => assert.fail('terminal child cannot run'));
    run = { requires: {}, execute: () => assert.fail('terminal child cannot run') };
  }
  class ChildB extends Group {
    checkpoint = checkpoint('child-b', () => assert.fail('wrong child cannot run'));
    run = { requires: {}, execute: () => assert.fail('wrong child cannot run') };
  }
  const a = new ChildA();
  const b = new ChildB();
  class Root extends Scene {
    members = [a, b];
    checkpoint = checkpoint(
      'root',
      async (work) => {
        const restored = work.children.resume(work.children.facts.requireUnique(a, { parentRound: 1 }).ref);
        assert.equal(await restored.run(), 'delivered');
        work.children.facts.require(b, restored.ref);
        return 'wrong contract was accepted';
      },
      [a, b],
    );
    run = { requires: {}, execute: () => assert.fail('not running original work') };
  }
  const store = new MemoryCheckpointStore();
  store.save(savedRoot([returnedChild()]), 0);
  const runtime = installCallable(new Root(), { source, providers: [], checkpoints: { store } });
  await assert.rejects(runtime.resume('root-context', {}), /contract|ownership|different declaration/);
  assert.equal(runtime.running, false);
});

for (const reception of ['pending', 'receiving']) {
  test(`a saved ${reception} child delivers one decoded value through cached lookup and parent reception`, async () => {
    let decoded = 0;
    const facts = [];
    class Child extends Group {
      checkpoint = {
        ...checkpoint('child-a', () => assert.fail('terminal child cannot resume work')),
        output: {
          encode: (value) => ({ wire: value.value }),
          decode(value) {
            decoded++;
            return Object.freeze({ value: value.wire });
          },
        },
      };
      run = { requires: {}, execute: () => assert.fail('terminal child cannot execute work') };
    }
    const child = new Child();
    class Root extends Scene {
      members = [child];
      checkpoint = checkpoint(
        'root',
        async (work) => {
          const call = work.children.resume(work.children.facts.requireUnique(child, { parentRound: 1 }).ref);
          const decodesBeforeLookup = decoded;
          const again = work.children.resume(call.ref);
          assert.equal(again.ref, call.ref);
          assert.equal(decoded, decodesBeforeLookup);
          assert.equal(await again.run(), await call.run());
          const relation = work.children.facts.get(call.ref);
          const delivered = await call.run();
          assert.equal(relation.returned.output, delivered);
          assert.equal(work.children.facts.get(call.ref).returned.output, delivered);
          const result = await call.accept((output) => {
            assert.equal(output, delivered);
            return output.value + 1;
          });
          work.checkpoint.save(this.checkpoint.points[0], null, {});
          return result;
        },
        [child],
      );
      run = { requires: {}, execute: () => assert.fail('not running original work') };
    }
    const saved = returnedChild();
    saved.state.output = { wire: 7 };
    saved.state.reception = { kind: reception };
    const store = new MemoryCheckpointStore();
    store.save(savedRoot([saved]), 0);
    const runtime = installCallable(new Root(), { source, providers: [], checkpoints: { store, observation: { observe: (fact) => facts.push(fact) } } });
    assert.equal(await runtime.resume('root-context', {}), 8);
    assert.ok(decoded >= 1, 'saved checks may decode separately; cached call preserves one delivery identity');
    const captured = store.read('root-context').image.frame.children[0];
    assert.deepEqual(captured.state.output, { wire: 7 });
    assert.deepEqual(captured.state.reception, { kind: 'accepted', output: 8 });
    assert.equal(facts.filter((fact) => fact.kind === 'child-restored').length, 1);
    const relationFacts = facts.filter((fact) => fact.kind === 'activity' && fact.fact.kind === 'relation').map((fact) => fact.fact.change.kind);
    assert.deepEqual(relationFacts, ['receiving', 'accepted'], 'baseline installation must not replay child attachment or return');
  });
}

test('checkpoint head validation rejects accessors without evaluating them', () => {
  let reads = 0;
  const value = {
    get revision() {
      reads += 1;
      return 1;
    },
    get image() {
      reads += 1;
      return savedRoot([]);
    },
  };
  assert.throws(() => cloneCheckpointHead(value));
  assert.equal(reads, 0);
});

test('a valid image and final delivery stay decodable together after the store commits them', () => {
  const store = new MemoryCheckpointStore();
  const value = 'x'.repeat(Math.floor(CHECKPOINT_MAX_BYTES * 0.6));
  const image = { ...savedRoot([]), state: value };
  store.save(image, 0);
  const head = store.finish('root-context', 1, { status: 'succeeded', output: value, progress: { round: 1, phase: 'receive', currentInput: {} } });
  assert.doesNotThrow(() => cloneCheckpointHead(head));
});

test('fixed child deliveries require explicit final progress and stable sibling order', () => {
  for (const progress of [undefined, { round: 0, phase: 'receive', currentInput: {} }, { round: 3, phase: 'receive', currentInput: {} }, { round: 1, phase: 'receive' }, { round: 1, currentInput: {} }, { round: 1, phase: 'unknown', currentInput: {} }]) {
    const child = returnedChild();
    if (progress === undefined) delete child.state.progress;
    else child.state.progress = progress;
    assert.throws(() => cloneCheckpointImage(savedRoot([child])));
    assert.throws(() => cloneCheckpointDelivery({ status: 'succeeded', output: 'fixed', ...(progress ? { progress } : {}) }));
  }
  const first = returnedChild();
  const second = { ...returnedChild(), identity: { contextId: 'second-child', parentContextId: 'root-context', kind: 'group' }, order: 1 };
  assert.doesNotThrow(() => cloneCheckpointImage(savedRoot([first, second])));
  assert.throws(() => cloneCheckpointImage(savedRoot([second, first])), /order/);
});

test('a final child delivery preserves its own second-round input without rerunning child work', async () => {
  class Child extends Group {
    maxRounds = 2;
    checkpoint = checkpoint('child-a', () => assert.fail('terminal child cannot resume'));
    run = { requires: {}, execute: () => assert.fail('terminal child cannot execute') };
  }
  const child = new Child();
  class Root extends Scene {
    members = [child];
    checkpoint = checkpoint(
      'root',
      async (work) => {
        const call = work.children.resume(work.children.facts.requireUnique(child, { parentRound: 1 }).ref);
        assert.equal(work.children.facts.get(call.ref).progress.round, 2);
        assert.equal(work.children.facts.get(call.ref).progress.phase, 'handling');
        assert.equal(work.children.facts.get(call.ref).progress.result, undefined, 'final output cannot impersonate an unsaved execute result');
        assert.deepEqual(work.children.facts.get(call.ref).progress.currentInput, { retry: true });
        assert.deepEqual(work.children.facts.get(call.ref).input, {});
        assert.equal(await call.run(), 'final round output');
        return call.accept((output) => output);
      },
      [child],
    );
    run = { requires: {}, execute: () => assert.fail('not running original work') };
  }
  const relation = returnedChild();
  relation.state = { kind: 'waiting' };
  const store = new MemoryCheckpointStore();
  store.save(savedRoot([relation]), 0);
  store.save({ id: 'child-cp', formatVersion: 4, contract: { key: 'child-a', version: 1 }, point: 'saved', frame: { owner: relation.identity, round: 1, phase: 'execute', input: {}, currentInput: {}, nextChildOrder: 0, children: [] }, state: null, references: {} }, 0);
  store.finish('child-context', 1, { status: 'succeeded', output: 'final round output', progress: { round: 2, phase: 'handling', currentInput: { retry: true } } });
  const runtime = installCallable(new Root(), { source, providers: [], checkpoints: { store } });
  assert.equal(await runtime.resume('root-context', {}), 'final round output');
});

test('two runtime structures cannot continue the same work through a shared checkpoint installation', async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  class Root extends Scene {
    checkpoint = checkpoint('root', async () => {
      entered();
      await pending;
      return 'finished once';
    });
    run = { requires: {}, execute: () => assert.fail('not running original work') };
  }
  const store = new MemoryCheckpointStore();
  store.save(savedRoot([]), 0);
  const first = installCallable(new Root(), { source, providers: [], checkpoints: { store } });
  const second = installCallable(new Root(), { source, providers: [], checkpoints: { store } });
  const running = first.resume('root-context', {});
  await ready;
  await assert.rejects(second.resume('root-context', {}), /already active/);
  assert.equal(store.read('root-context').delivery, undefined, 'rejected competing continuation cannot close the actual work');
  release();
  assert.equal(await running, 'finished once');
  assert.equal(store.read('root-context').delivery.status, 'succeeded');
});

test('ordinary parallel child receptions remain supported without checkpoint or fixed entity access', async () => {
  class Child extends Group {
    run = { requires: {}, execute: () => 1 };
  }
  const child = new Child();
  class Root extends Scene {
    members = [child];
    run = {
      requires: {},
      uses: [child],
      async execute(work) {
        const first = work.children.create(child, {});
        const second = work.children.create(child, {});
        await Promise.all([first.run(), second.run()]);
        return Promise.all([
          first.accept(async (output) => {
            await Promise.resolve();
            return output;
          }),
          second.accept(async (output) => {
            await Promise.resolve();
            return output;
          }),
        ]);
      },
    };
  }
  const runtime = installCallable(new Root(), { source, providers: [] });
  assert.deepEqual(await runtime.run({}, {}), [1, 1]);
});

test('a rejected continuation check publishes its failure without closing the saved work', async () => {
  const facts = [];
  const store = new MemoryCheckpointStore();
  const saved = store.save(savedRoot([]), 0);
  class Root extends Scene {
    checkpoint = {
      ...checkpoint('root', () => assert.fail('rejected continuation must not run')),
      points: [
        {
          name: 'saved',
          references: {},
          state: codec,
          check: () => {
            throw new Error('fixed entity is incompatible');
          },
          resume: { requires: {}, execute: () => assert.fail('rejected continuation must not run') },
        },
      ],
    };
    run = { requires: {}, execute: () => assert.fail('not running original work') };
  }
  const runtime = installCallable(new Root(), { source, providers: [], checkpoints: { store, observation: { observe: (fact) => facts.push(fact) } } });
  await assert.rejects(runtime.resume('root-context', {}), /incompatible/);
  assert.equal(store.read('root-context'), saved);
  assert.ok(facts.some((fact) => fact.kind === 'failed' && fact.stage === 'restore'));
  assert.equal(
    facts.some((fact) => fact.kind === 'continued'),
    false,
  );
});
