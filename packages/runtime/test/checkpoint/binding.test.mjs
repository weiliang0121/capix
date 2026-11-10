import { installCallable } from '../fixtures/driver.mjs';

import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Scene, Group, bindCallSource } from '@weiliang0121/capix-runtime';

import { ResourceOffer } from '@weiliang0121/capix-resources';

import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };

function checkpoint(key, execute, deps = {}, uses = []) {
  return { key, version: 1, input: codec, output: codec, points: [{ name: 'saved', state: codec, references: {}, resume: { deps, uses, run: execute } }] };
}

function head(key, contextId, kind, state, children = [], parentContextId) {
  return {
    revision: 1,
    image: {
      id: `checkpoint-${contextId}`,
      formatVersion: 6,
      contract: { key, version: 1 },
      point: 'saved',
      frame: { owner: { contextId, kind, ...(parentContextId ? { parentContextId } : {}) }, round: 1, phase: 'execute', input: { original: contextId }, currentInput: { original: contextId }, nextChildOrder: children.length, children },
      state,
      references: {},
    },
  };
}

function storeOf(...initial) {
  const store = new MemoryCheckpointStore();
  for (const head of initial) {
    store.save(head.image, 0);
    if (head.delivery) store.finish(head.image.frame.owner.contextId, 1, head.delivery);
  }
  return store;
}

function assemble(definition, options = {}) {
  return installCallable(definition, { providers: [], source: { capture: () => null }, ...options });
}

test('checkpoint declarations do not change normal execution when persistence is absent', async () => {
  class Root extends Scene {
    checkpoint = checkpoint('test.optional', () => assert.fail('not resuming'));
    deps = {};
    run = function (work) {
      assert.equal(work.checkpoint, undefined);
      return work.input;
    };
  }
  const runtime = assemble(new Root());
  assert.equal(await runtime.run('normal', {}), 'normal');
  await assert.rejects(runtime.resume('missing', {}), /not installed/);
  assert.equal(runtime.running, false);
});

test('a checkpoint continuation exposes only its declared resources, and installs the original work identity', async () => {
  const normal = new ResourceOffer({ name: 'test.checkpoint.normal', expose: () => assert.fail('normal work endpoint must not be exposed'), timing: 'binding' });
  let resumed = 0;
  const continuation = new ResourceOffer({
    name: 'test.checkpoint.resume',
    expose: (value) => {
      resumed++;
      return { read: () => value };
    },
    timing: 'binding',
  });
  class Root extends Scene {
    checkpoint = checkpoint(
      'test.resources',
      (work, state) => {
        assert.equal('id' in work, false);
        assert.equal(work.round, 1);
        assert.deepEqual(work.initialInput, { original: 'root-1' });
        assert.deepEqual(Object.keys(work.resources), ['continuation']);
        assert.equal(work.resources.continuation.read(), 7);
        return state.answer;
      },
      { continuation: continuation.request() },
    );
    deps = { normal: normal.request() };
    run = () => assert.fail('normal execution cannot be replayed');
  }
  const store = storeOf(head('test.resources', 'root-1', 'scene', { answer: 'saved answer' }));
  const runtime = assemble(new Root(), {
    checkpoints: { store },
    providers: [normal.provide(() => null), continuation.provide(() => 7)],
    source: { capture: () => null },
  });
  assert.equal(await runtime.resume('root-1', {}), 'saved answer');
  assert.equal(resumed, 1);
  assert.equal(runtime.running, false);
  await assert.rejects(runtime.resume('root-1', {}), /terminal/);
  assert.equal(resumed, 1);
});

test('resuming a direct member uses fixed input without repeating parent preparation or original started callbacks', async () => {
  let captures = 0;
  class Child extends Group {
    checkpoint = checkpoint('test.child', (work, state) => {
      assert.deepEqual(work.initialInput, { original: 'child-1' });
      return state.answer;
    });
    deps = {};
    run = () => assert.fail('child execute must not repeat');
  }
  const child = new Child();
  class Root extends Scene {
    constructor() {
      super();
      this.add(child);
    }
    checkpoint = checkpoint(
      'test.parent',
      async (work) => {
        const restored = work.children.resume(work.children.facts.requireUnique(child, { parentRound: 1 }).ref);
        assert.equal(await restored.run(), 'fixed response');
        return restored.accept((result) => `accepted ${result}`);
      },
      {},
      [child],
    );
    deps = {};
    run = () => assert.fail('parent execute must not repeat');
  }
  const relation = { target: { position: 0 }, identity: { contextId: 'child-1', kind: 'group', parentContextId: 'parent-1' }, contract: { key: 'test.child', version: 1 }, round: 1, order: 0, key: 'selected-execution', input: { original: 'child-1' }, state: { kind: 'waiting' } };
  const store = storeOf(head('test.parent', 'parent-1', 'scene', {}, [relation]), head('test.child', 'child-1', 'group', { answer: 'fixed response' }, [], 'parent-1'));
  const runtime = assemble(new Root(), {
    checkpoints: { store },
    bindings: [
      bindCallSource(child, {
        capture: (input) => {
          captures++;
          assert.deepEqual(input, { original: 'child-1' });
          return null;
        },
        started: () => () => assert.fail('original submission started callback must not repeat'),
      }),
    ],
  });
  assert.equal(await runtime.resume('parent-1', {}), 'accepted fixed response');
  assert.equal(captures, 1);
});

test('a new member created within recovery still registers its new call before work', async () => {
  const order = [];
  let identity;
  class Child extends Group {
    deps = {};
    run = function (work) {
      order.push('execute');
      return work.input;
    };
  }
  const child = new Child();
  class Root extends Scene {
    constructor() {
      super();
      this.add(child);
    }
    checkpoint = checkpoint(
      'test.parent-new-child',
      async (work) => {
        const next = work.children.create(child, 'new work');
        await next.run();
        return next.accept();
      },
      {},
      [child],
    );
    deps = {};
    run = () => assert.fail('parent execute must not repeat');
  }
  const runtime = assemble(new Root(), {
    checkpoints: { store: storeOf(head('test.parent-new-child', 'parent-1', 'scene', {})) },
    bindings: [
      bindCallSource(child, {
        capture() {
          order.push('capture');
          return null;
        },
        started: () => (context, invocation) => {
          order.push('started');
          identity = invocation.identity;
          assert.equal(context.id, identity.contextId);
          assert.equal(invocation.restoring, false);
          assert.equal(invocation.recovering, true);
        },
      }),
    ],
  });
  assert.equal(await runtime.resume('parent-1', {}), 'new work');
  assert.deepEqual(order, ['capture', 'started', 'execute']);
  assert.equal(identity.parentContextId, 'parent-1');
  assert.notEqual(identity.contextId, 'parent-1');
});

test('checkpoint-only resources and children must be covered during assembly', () => {
  const missing = new ResourceOffer({ name: 'test.checkpoint.missing', expose: (value) => value });
  class Root extends Scene {
    checkpoint = checkpoint('test.invalid-resource', () => null, { missing: missing.request() });
    deps = {};
    run = () => null;
  }
  assert.throws(() => assemble(new Root()), /Expected one resource provider/);
  class Unknown extends Group {
    name = 'unknown';
    label = 'unknown';
    source = 'test';
    deps = {};
    run = () => null;
  }
  const unknown = new Unknown();
  class BadChild extends Group {
    checkpoint = checkpoint('test.invalid-child', () => null, {}, [unknown]);
    deps = {};
    run = () => null;
  }
  class BadRoot extends Scene {
    constructor() {
      super();
      this.add(new BadChild());
    }
    deps = {};
    run = () => null;
  }
  assert.throws(() => assemble(new BadRoot()), /outside its owner/);
});

test('restoration rejects incompatible ownership and contract before constructing resource captures', async () => {
  let captures = 0;
  const resource = new ResourceOffer({ name: 'test.checkpoint.guard', expose: (value) => value });
  class Root extends Scene {
    checkpoint = checkpoint('test.guard', () => null, { value: resource.request() });
    deps = {};
    run = () => assert.fail('not running');
  }
  for (const saved of [head('other.contract', 'root-1', 'scene', {}), head('test.guard', 'root-1', 'group', {}, [], 'another-parent')]) {
    const runtime = assemble(new Root(), {
      checkpoints: { store: storeOf(saved) },
      providers: [resource.provide(() => null)],
      source: {
        capture: () => {
          captures++;
          return null;
        },
      },
    });
    await assert.rejects(runtime.resume('root-1', {}), /incompatible|another scope/);
    assert.equal(runtime.running, false);
  }
  assert.equal(captures, 0);
});

test('restored work and newly created descendants use the recovery observation source', async () => {
  const facts = [];
  const resource = new ResourceOffer({ name: 'test.checkpoint.observed', expose: (value, activity) => ({ read: () => activity.runSync('read', {}, () => value) }) });
  class Child extends Group {
    deps = { value: resource.request() };
    run = (work) => work.resources.value.read();
  }
  const child = new Child();
  class Root extends Scene {
    constructor() {
      super();
      this.add(child);
    }
    checkpoint = checkpoint(
      'test.observation',
      async (work) => {
        const next = work.children.create(child, {});
        await next.run();
        return next.accept((output) => output);
      },
      {},
      [child],
    );
    deps = {};
    run = () => assert.fail('not running original work');
  }
  const runtime = assemble(new Root(), {
    checkpoints: { store: storeOf(head('test.observation', 'root-1', 'scene', {})), observation: { observe: (fact) => facts.push(fact) } },
    observations: [{ bindInvocation: () => assert.fail('recovery cannot enter the original record installation') }],
    changes: { capture: () => assert.fail('original change source cannot identify recovery activities') },
    providers: [resource.provide(() => 'new child result')],
  });
  assert.equal(await runtime.resume('root-1', {}), 'new child result');
  assert.ok(facts.some((fact) => fact.kind === 'installed' && fact.contextId === 'root-1'));
  assert.ok(facts.some((fact) => fact.kind === 'activity' && fact.contextId !== 'root-1'));
  assert.ok(facts.some((fact) => fact.kind === 'resource'));
  const rootActivity = facts.find((fact) => fact.contextId === 'root-1').activityId;
  assert.equal(typeof rootActivity, 'string');
});

for (const failure of [undefined, 'propagate']) {
  test(`read rejection emits one restore failure and ${failure ? 'preserves both strict faults' : 'isolates observer faults'}`, async () => {
    const observerError = new Error('failure observer failed');
    const facts = [];
    class Root extends Scene {
      checkpoint = checkpoint('test.expected', () => assert.fail('incompatible work must not run'));
      deps = {};
      run = () => assert.fail('not normal execution');
    }
    const runtime = assemble(new Root(), {
      checkpoints: {
        store: storeOf(head('test.other', 'root-1', 'scene', {})),
        observation: {
          failure,
          observe: (fact) => {
            facts.push(fact);
            throw observerError;
          },
        },
      },
    });
    await assert.rejects(runtime.resume('root-1', {}), (error) => {
      const original = facts[0].error;
      assert.match(original.message, /incompatible/);
      if (!failure) assert.equal(error, original);
      else {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.cause, original);
        assert.equal(error.errors[0], original);
        assert.equal(error.errors[1].cause, observerError);
      }
      return true;
    });
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, 'failed');
    assert.equal(facts[0].stage, 'restore');
    assert.equal(facts[0].contextId, 'root-1');
    assert.equal(facts[0].sequence, 1);
    assert.equal(runtime.running, false);
  });
}

for (const stage of ['point', 'codec', 'capture']) {
  test(`a restore ${stage} construction failure is observed once before invocation installation`, async () => {
    const expected = new Error(`${stage} unavailable`);
    const facts = [];
    const resource = new ResourceOffer({ name: `test.restore.${stage}`, expose: () => assert.fail('unavailable work must not expose a resource'), timing: 'binding' });
    class Root extends Scene {
      checkpoint = {
        ...checkpoint('test.construction', () => assert.fail('not resuming'), { resource: resource.request() }),
        input:
          stage === 'codec'
            ? {
                encode: codec.encode,
                decode: () => {
                  throw expected;
                },
              }
            : codec,
      };
      deps = {};
      run = () => assert.fail('not normal execution');
    }
    const saved = head('test.construction', 'root-1', 'scene', {});
    if (stage === 'point') saved.image.point = 'unknown-point';
    const store = storeOf(saved);
    const runtime = assemble(new Root(), {
      checkpoints: { store, observation: { observe: (fact) => facts.push(fact) } },
      providers: [
        resource.provide(() => {
          if (stage === 'capture') throw expected;
          return null;
        }),
      ],
      source: { capture: () => null },
    });
    await assert.rejects(runtime.resume('root-1', {}), stage === 'point' ? /point is not declared/ : (error) => error === expected);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].kind, 'failed');
    assert.equal(facts[0].stage, 'restore');
    assert.equal(facts[0].contextId, 'root-1');
    assert.equal(store.read('root-1').delivery, undefined);
    assert.equal(runtime.running, false);
  });
}
