import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CallableBinder, Clock, Driver, MemoryCheckpointStore, checkpointPoint, defineScene, defineGroup, defineNode } from '@capix/server-runtime';

const source = { capture: () => null };
const codec = { encode: (value) => value, decode: (value) => value };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function observation(facts, calls = []) {
  return {
    bindDriver() {
      return { observe: (fact) => facts.push(fact) };
    },
    bindInvocation() {
      return { observe: (fact) => calls.push(fact) };
    },
  };
}

function bind(driver, definition, options = {}) {
  return driver.bind(definition, { source, providers: [], ...options });
}

test('one Driver explicitly selects scene, group and node bindings without a current entry', async () => {
  const driver = new Driver();
  const definitions = [defineScene()({ run: { execute: (work) => `scene:${work.input}` } }), defineGroup()({ run: { execute: (work) => `group:${work.input}` } }), defineNode()({ run: { execute: (work) => `node:${work.input}` } })];
  const bounds = definitions.map((definition) => bind(driver, definition));
  assert.deepEqual(await Promise.all(bounds.map((bound) => driver.run(bound, 'input', {}))), ['scene:input', 'group:input', 'node:input']);
  for (const bound of bounds) assert.equal(driver.isRunning(bound), false);
  assert.equal('callable' in driver, false);
  assert.equal('running' in driver, false);
});

test('Driver rejects foreign, bare and forged bounds before source capture or entry activity', async () => {
  const facts = [];
  const driver = new Driver({ observations: [observation(facts)] });
  const other = new Driver();
  let captures = 0;
  const options = {
    providers: [],
    source: {
      capture() {
        captures++;
        return null;
      },
    },
  };
  const definition = defineNode()({ run: { execute: () => assert.fail('unowned call must not run') } });
  const own = driver.bind(definition, options);
  const foreign = other.bind(definition, options);
  const bare = new CallableBinder().bind(definition, options);
  const forged = Object.assign(Object.create(Object.getPrototypeOf(own)), own);
  for (const bound of [foreign, bare, forged, { id: own.id }, null]) {
    await assert.rejects(driver.run(bound, null, {}), (error) => error.code === 'FOREIGN_BINDING');
    await assert.rejects(driver.resume(bound, 'saved-context', {}), (error) => error.code === 'FOREIGN_BINDING');
    assert.throws(
      () => driver.isRunning(bound),
      (error) => error.code === 'FOREIGN_BINDING',
    );
  }
  assert.equal(captures, 0);
  assert.equal(driver.isRunning(own), false);
  assert.deepEqual(
    facts.map((fact) => fact.kind),
    ['established'],
  );
});

test('binding installations stay distinct even under one Driver', async () => {
  const entered = deferred();
  const finished = deferred();
  const driver = new Driver();
  let parent;
  const first = bind(
    driver,
    defineGroup()({
      run: {
        async execute() {
          entered.resolve();
          await finished.promise;
          return 'first';
        },
      },
    }),
    {
      source: {
        capture: () => null,
        started: () => (_context, invocation) => {
          parent = invocation;
        },
      },
    },
  );
  const second = bind(driver, defineNode()({ run: { execute: () => 'second' } }));
  const run = driver.run(first, null, {});
  await entered.promise;
  try {
    assert.throws(() => second.create(parent, null), /another binding installation/);
    assert.equal(await driver.run(second, null, {}), 'second');
    assert.equal(driver.isRunning(first), true);
  } finally {
    finished.resolve();
  }
  assert.equal(await run, 'first');
});

test('entry occupancy is per Bound and busy rejection cannot start a duplicate call', async () => {
  const facts = [];
  const driver = new Driver({ observations: [observation(facts)] });
  const entered = deferred();
  const finished = deferred();
  let captures = 0;
  const first = bind(
    driver,
    defineNode()({
      run: {
        async execute() {
          entered.resolve();
          return finished.promise;
        },
      },
    }),
    {
      source: {
        capture() {
          captures++;
          return null;
        },
      },
    },
  );
  const second = bind(driver, defineNode()({ run: { execute: () => 'independent' } }));
  const running = driver.run(first, null, {});
  await entered.promise;
  try {
    assert.equal(driver.isRunning(first), true);
    assert.equal(driver.isRunning(second), false);
    await assert.rejects(driver.run(first, null, {}), (error) => error.code === 'RUNTIME_BUSY');
    assert.equal(await driver.run(second, null, {}), 'independent');
    assert.equal(captures, 1);
    assert.equal(driver.isRunning(first), true);
  } finally {
    finished.resolve('complete');
  }
  assert.equal(await running, 'complete');
  assert.equal(driver.isRunning(first), false);
  assert.equal(facts[0].kind, 'established');
  assert.equal('boundId' in facts[0], false);
  assert.deepEqual(
    facts.filter((fact) => fact.boundId === first.id).map((fact) => fact.kind),
    ['acquired', 'rejected', 'released'],
  );
  assert.deepEqual(
    facts.filter((fact) => fact.boundId === second.id).map((fact) => fact.kind),
    ['acquired', 'released'],
  );
  assert.deepEqual(
    facts.map((fact) => fact.sequence),
    facts.map((_fact, index) => index + 1),
  );
  assert.ok(facts.every((fact) => fact.driverId === driver.id));
});

test('source and work failures release the same entry for a later call', async () => {
  const facts = [];
  const driver = new Driver({ observations: [observation(facts)] });
  const bound = bind(
    driver,
    defineNode()({
      run: {
        execute(work) {
          if (work.input === 'work') throw new Error('work failed');
          return 'ok';
        },
      },
    }),
    {
      source: {
        capture(_input, options) {
          if (options.fail) throw new Error('capture failed');
          return null;
        },
      },
    },
  );
  await assert.rejects(driver.run(bound, null, { fail: true }), /capture failed/);
  assert.equal(driver.isRunning(bound), false);
  await assert.rejects(driver.run(bound, 'work', {}), /work failed/);
  assert.equal(driver.isRunning(bound), false);
  assert.equal(await driver.run(bound, 'healthy', {}), 'ok');
  assert.equal(driver.isRunning(bound), false);
  assert.deepEqual(
    facts.filter((fact) => fact.boundId === bound.id).map((fact) => fact.kind),
    ['acquired', 'entry-failed', 'released', 'acquired', 'released', 'acquired', 'released'],
  );
});

test('pre-cancellation does not capture a source and cancellation never releases a still-running body', async () => {
  const driver = new Driver();
  const entered = deferred();
  const finished = deferred();
  let captures = 0;
  const bound = bind(
    driver,
    defineNode()({
      run: {
        async execute() {
          entered.resolve();
          return finished.promise;
        },
      },
    }),
    { source: { capture: () => captures++ } },
  );
  const before = new AbortController();
  before.abort();
  await assert.rejects(driver.run(bound, null, { signal: before.signal }), (error) => error.code === 'INVOCATION_CANCELLED');
  assert.equal(captures, 0);
  assert.equal(driver.isRunning(bound), false);

  const active = new AbortController();
  const outcome = driver.run(bound, null, { signal: active.signal }).then(
    () => assert.fail('a cancelled call cannot succeed'),
    (error) => error,
  );
  await entered.promise;
  active.abort();
  await Promise.resolve();
  assert.equal(driver.isRunning(bound), true);
  finished.resolve('late result');
  assert.equal((await outcome).code, 'INVOCATION_CANCELLED');
  assert.equal(driver.isRunning(bound), false);
});

test('strict entry observation failures still release occupancy and preserve a work failure', async () => {
  const original = new Error('business failure');
  const install = {
    failure: 'propagate',
    bindDriver() {
      return {
        observe(fact) {
          if (fact.kind === 'released') throw new Error('release observer failed');
        },
      };
    },
    bindInvocation: () => ({ observe() {} }),
  };
  const driver = new Driver({ observations: [install] });
  const bound = bind(
    driver,
    defineNode()({
      run: {
        execute(work) {
          if (work.input) throw original;
          return 'ok';
        },
      },
    }),
  );
  await assert.rejects(driver.run(bound, true, {}), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], original);
    assert.match(error.errors[1].message, /observation/i);
    return true;
  });
  assert.equal(driver.isRunning(bound), false);
  assert.equal(await driver.run(bound, false, {}), 'ok');
});

test('Driver mechanisms are fixed while supplied clocks and observation instances remain live', async () => {
  class CountingClock extends Clock {
    count = 0;
    now() {
      this.count++;
      return '2026-01-01T00:00:00.000Z';
    }
  }
  const clock = new CountingClock();
  const facts = [];
  const calls = [];
  const install = observation(facts, calls);
  install.label = 'original';
  const options = { clock, observations: [install] };
  const driver = new Driver(options);
  options.clock = new Clock();
  options.observations.length = 0;
  install.label = 'still mutable';
  const bound = bind(driver, defineNode()({ run: { execute: () => 'ok' } }));
  assert.equal(await driver.run(bound, null, {}), 'ok');
  assert.ok(clock.count > facts.length);
  assert.equal(install.label, 'still mutable');
  assert.equal(Object.isFrozen(clock), false);
  assert.equal(Object.isFrozen(install), false);
  assert.ok(calls.length > 0);
  assert.ok([...facts, ...calls].every((fact) => fact.occurredAt === '2026-01-01T00:00:00.000Z'));
});

test('Driver retains its installed checkpoint store and callback receiver across host option mutation', async () => {
  const store = new MemoryCheckpointStore();
  const other = new MemoryCheckpointStore();
  const observed = {
    facts: [],
    observe(fact) {
      this.facts.push(fact);
    },
  };
  const checkpoints = { store, observation: observed };
  const driver = new Driver({ checkpoints });
  checkpoints.store = other;
  checkpoints.observation = { observe: () => assert.fail('replacement callback must not install') };
  observed.observe = () => assert.fail('replacement method must not install');
  const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { requires: {}, execute: (_work, state) => state } });
  const definition = defineNode()({
    checkpoint: { key: 'driver.node', version: 1, input: codec, output: codec, points: [point] },
    run: {
      execute(work) {
        work.checkpoint.save(point, 'result', {});
        return 'result';
      },
    },
  });
  const bound = bind(driver, definition);
  assert.equal(driver.checkpointStore, store);
  assert.equal(new Driver().checkpointStore, undefined);
  assert.equal(await driver.run(bound, null, {}), 'result');
  const saved = observed.facts.find((fact) => fact.kind === 'saved');
  assert.ok(saved);
  assert.equal(store.read(saved.contextId).delivery.status, 'succeeded');
  assert.equal(other.read(saved.contextId), undefined);
  assert.equal(Object.isFrozen(store), false);
  assert.equal(Object.isFrozen(observed), false);
});

test('resume explicitly selects an owned binding and releases failures without replaying work or started hooks', async () => {
  const store = new MemoryCheckpointStore();
  const facts = [];
  const driver = new Driver({ checkpoints: { store }, observations: [observation(facts)] });
  const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { requires: {}, execute: (work, state) => `${work.input}:${state}` } });
  const definition = defineNode()({
    checkpoint: { key: 'driver.resume', version: 1, input: codec, output: codec, points: [point] },
    run: { execute: () => assert.fail('resume must not execute the initial body') },
  });
  let captures = 0;
  const bound = bind(driver, definition, {
    source: {
      capture(input, options) {
        captures++;
        assert.equal(input, 'original');
        assert.equal(options.tenant, 'fixed');
        return null;
      },
      started: () => () => assert.fail('restored identity must not repeat its established hook'),
    },
  });
  await assert.rejects(driver.resume(bound, 'missing', { tenant: 'fixed' }), /checkpoint/i);
  assert.equal(driver.isRunning(bound), false);
  assert.equal(captures, 0);
  store.save(
    {
      id: 'saved-checkpoint',
      formatVersion: 4,
      contract: { key: 'driver.resume', version: 1 },
      point: 'saved',
      frame: { owner: { contextId: 'saved-context', kind: 'node' }, round: 1, phase: 'execute', input: 'original', currentInput: 'original', nextChildOrder: 0, children: [] },
      state: 'continued',
      references: {},
    },
    0,
  );
  assert.equal(await driver.resume(bound, 'saved-context', { tenant: 'fixed' }), 'original:continued');
  assert.equal(driver.isRunning(bound), false);
  assert.equal(captures, 1);
  assert.equal(store.read('saved-context').delivery.status, 'succeeded');
  assert.deepEqual(
    facts.filter((fact) => fact.boundId === bound.id).map((fact) => fact.kind),
    ['acquired', 'entry-failed', 'released', 'acquired', 'released'],
  );
});
