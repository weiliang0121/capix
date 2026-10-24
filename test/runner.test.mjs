import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runner, Resources, Scene, Node, ResourceOffer, ExceptionContract, MemoryCheckpointStore, checkpointPoint, callableHooks } from '@capix/server-runtime';

const codec = { encode: (value) => value, decode: (value) => value };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function scene(execute = (work) => work.input) {
  return new Scene({ run: { execute } });
}

function observation(facts) {
  return {
    bindDriver: () => ({
      observe(fact) {
        facts.push(fact);
      },
    }),
    bindInvocation: () => ({ observe() {} }),
  };
}

test('Runner fixes one scene and builds itself; every run starts a fresh call', async () => {
  const contexts = [];
  const root = scene();
  const runner = new Runner(root, new Resources(), undefined, {
    hooks: [
      callableHooks(root, {
        started: () => (context) => {
          contexts.push(context.id);
        },
      }),
    ],
  });
  assert.equal(runner.scene, root);
  assert.equal(runner.isRunning, false);
  await assert.rejects(runner.run('before'), /must be built/);
  await assert.rejects(runner.resume('before'), /must be built/);
  assert.equal(runner.build(), runner);
  assert.equal(await runner.run('first'), 'first');
  assert.equal(await runner.run('second'), 'second');
  assert.equal(new Set(contexts).size, 2);
  assert.equal(runner.isRunning, false);
  assert.throws(() => runner.build(), /already been built/);
  assert.throws(() => root.setRun({ execute: () => 'replacement' }), /built|fixed|configur/i);
  assert.throws(() => new Runner(new Node({ run: { execute: () => 'leaf' } }), new Resources()), /requires a Scene/);
});

test('failed Runner builds can be corrected, but reentrant build never publishes a partial installation', async () => {
  const root = new Scene();
  let runner;
  let checked = false;
  const install = {
    check() {
      checked = true;
      assert.throws(() => runner.build(), /already in progress/);
    },
    bindInvocation: () => ({ observe() {} }),
  };
  runner = new Runner(root, new Resources(), undefined, { observations: [install] });
  assert.throws(() => runner.build(), /requires execute/);
  root.setRun({ execute: (work) => work.input });
  assert.equal(runner.build(), runner);
  assert.equal(checked, true);
  assert.equal(await runner.run('healthy'), 'healthy');
});

test('Runner stays occupied until the real body exits, with independent occupancy for another scene', async () => {
  const facts = [];
  const entered = deferred();
  const released = deferred();
  const root = scene(async () => {
    entered.resolve();
    return released.promise;
  });
  const runner = new Runner(root, new Resources(), undefined, { observations: [observation(facts)] }).build();
  const other = new Runner(
    scene(() => 'independent'),
    new Resources(),
  ).build();
  const running = runner.run(null);
  await entered.promise;
  assert.equal(runner.isRunning, true);
  await assert.rejects(runner.run(null), (error) => error.code === 'RUNTIME_BUSY');
  assert.equal(await other.run(null), 'independent');
  released.resolve('complete');
  assert.equal(await running, 'complete');
  assert.equal(runner.isRunning, false);
  assert.deepEqual(
    facts.map((fact) => fact.kind),
    ['established', 'acquired', 'rejected', 'released'],
  );
  assert.ok(facts.every((fact) => fact.driverId === runner.id));
  assert.ok(facts.slice(1).every((fact) => fact.boundId === root.id));
});

test('pre-cancellation skips host validation; active cancellation waits for a started child', async () => {
  const childEntered = deferred();
  const childExit = deferred();
  let validations = 0;
  const child = new Node({
    run: {
      async execute() {
        childEntered.resolve();
        return childExit.promise;
      },
    },
  });
  const root = new Scene().add(child);
  root.setRun({
    async execute(work) {
      const call = work.children.create(child, null);
      await call.run();
      return call.accept();
    },
  });
  const runner = new Runner(root, new Resources(), undefined, {
    validate() {
      validations++;
    },
  }).build();
  const before = new AbortController();
  before.abort();
  await assert.rejects(runner.run(null, { signal: before.signal }), (error) => error.code === 'INVOCATION_CANCELLED');
  assert.equal(validations, 0);
  assert.equal(runner.isRunning, false);
  const active = new AbortController();
  const outcome = runner.run(null, { signal: active.signal }).then(
    () => assert.fail('cancelled run cannot succeed'),
    (error) => error,
  );
  await childEntered.promise;
  active.abort();
  await Promise.resolve();
  assert.equal(runner.isRunning, true);
  childExit.resolve('late');
  assert.equal((await outcome).code, 'INVOCATION_CANCELLED');
  assert.equal(runner.isRunning, false);
  assert.equal(validations, 1);
});

test('call hooks are registered by exact root/child identity and retain their receiver and built methods', async () => {
  const child = new Node({ run: { execute: (work) => `${work.input}:child` } });
  const root = new Scene().add(child);
  root.setRun({
    async execute(work) {
      const call = work.children.create(child, work.input);
      await call.run();
      return call.accept();
    },
  });
  const established = [];
  const progress = [];
  const outputs = [];
  const rootHooks = {
    label: 'root',
    validate(input, options) {
      assert.equal(input, 'hello');
      assert.equal(options.label, 'test');
    },
    started(input, options) {
      assert.equal(input, 'hello');
      assert.equal(options.label, 'test');
      const label = this.label;
      return (context) => {
        established.push([label, context.id]);
      };
    },
    progress() {
      return {
        receive: (fact) => {
          progress.push(fact);
        },
      };
    },
    output() {
      return {
        receive: (fact) => {
          outputs.push(fact);
        },
      };
    },
  };
  const childHooks = {
    started: () => (context) => {
      established.push(['child', context.id]);
    },
  };
  const runner = new Runner(root, new Resources(), undefined, {
    hooks: [callableHooks(root, rootHooks), callableHooks(child, childHooks)],
  }).build();
  rootHooks.label = 'live-receiver';
  rootHooks.started = () => assert.fail('replacement method must not install');
  rootHooks.progress = () => assert.fail('replacement progress must not install');
  childHooks.started = () => assert.fail('replacement child method must not install');
  assert.equal(await runner.run('hello', { label: 'test' }), 'hello:child');
  assert.deepEqual(
    established.map(([label]) => label),
    ['live-receiver', 'child'],
  );
  assert.equal(new Set(established.map(([, id]) => id)).size, 2);
  assert.ok(progress.length > 0);
  assert.ok(outputs.some((fact) => fact.kind === 'completed' && fact.result === 'hello:child'));
});

test('foreign and duplicate hook registrations fail before a structure becomes runnable', () => {
  const root = scene();
  const foreign = scene();
  assert.throws(
    () =>
      new Runner(root, new Resources(), undefined, {
        hooks: [callableHooks(foreign, {})],
      }).build(),
    /in this scene/,
  );
  assert.throws(
    () =>
      new Runner(root, new Resources(), undefined, {
        hooks: [callableHooks(root, {}), callableHooks(root, {})],
      }).build(),
    /Duplicate/,
  );
  // Failed registrations did not lock or partially install the scene.
  root.setRun({ execute: () => 'repaired' });
  new Runner(root, new Resources()).build();
});

test('started remains required synchronous establishment and failure never starts business work', async () => {
  let executed = 0;
  const root = scene(() => {
    executed++;
    return 'ok';
  });
  const runner = new Runner(root, new Resources(), undefined, {
    hooks: [
      callableHooks(root, {
        started(input) {
          if (input === 'throw')
            return () => {
              throw new Error('registration failed');
            };
          if (input === 'async')
            return async () => {
              throw new Error('late registration failure');
            };
          if (input === 'value') return () => 1;
          return () => undefined;
        },
      }),
    ],
  }).build();
  await assert.rejects(runner.run('throw'), /registration failed/);
  assert.equal(runner.isRunning, false);
  await assert.rejects(runner.run('async'), /undefined synchronously/);
  await assert.rejects(runner.run('value'), /undefined synchronously/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executed, 0);
  assert.equal(await runner.run('valid'), 'ok');
  assert.equal(executed, 1);
});

test('per-call validation failure releases occupancy and asynchronous validators cannot be silently accepted', async () => {
  let executed = 0;
  const root = scene(() => {
    executed++;
    return 'ok';
  });
  const runner = new Runner(root, new Resources(), undefined, {
    hooks: [
      callableHooks(root, {
        validate(input) {
          if (input === 'throw') throw new Error('validation failed');
          if (input === 'async') return Promise.reject(new Error('late validation failure'));
        },
      }),
    ],
  }).build();
  await assert.rejects(runner.run('throw'), /validation failed/);
  assert.equal(runner.isRunning, false);
  await assert.rejects(runner.run('async'), /undefined synchronously/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executed, 0);
  assert.equal(await runner.run('valid'), 'ok');
});

test('Runner resume keeps the original identity and input and skips started registration', async () => {
  const store = new MemoryCheckpointStore();
  const point = checkpointPoint()({ name: 'saved', state: codec, references: {}, resume: { requires: {}, execute: (work, state) => `${work.input}:${state}` } });
  const root = new Scene({
    checkpoint: { key: 'runner.resume', version: 1, input: codec, output: codec, points: [point] },
    run: { execute: () => assert.fail('resume must not replay the original body') },
  });
  let validated = 0;
  const runner = new Runner(root, new Resources(), undefined, {
    checkpoints: { store },
    hooks: [
      callableHooks(root, {
        validate(input, options) {
          validated++;
          assert.equal(input, 'original');
          assert.equal(options.scope, 'fixed');
        },
        started: () => () => assert.fail('restored identity must not repeat establishment'),
      }),
    ],
  }).build();
  assert.equal(runner.checkpointStore, store);
  await assert.rejects(runner.resume('missing', { scope: 'fixed' }), /checkpoint/i);
  assert.equal(runner.isRunning, false);
  assert.equal(validated, 0);
  store.save(
    {
      id: 'runner-saved',
      formatVersion: 4,
      contract: { key: 'runner.resume', version: 1 },
      point: 'saved',
      frame: { owner: { contextId: 'runner-context', kind: 'scene' }, round: 1, phase: 'execute', input: 'original', currentInput: 'original', nextChildOrder: 0, children: [] },
      state: 'continued',
      references: {},
    },
    0,
  );
  assert.equal(await runner.resume('runner-context', { scope: 'fixed' }), 'original:continued');
  assert.equal(runner.isRunning, false);
  assert.equal(validated, 1);
  assert.equal(store.read('runner-context').delivery.status, 'succeeded');
});

test('strict host observation failure releases occupancy without hiding the original work error', async () => {
  const original = new Error('business failure');
  const install = {
    failure: 'propagate',
    bindDriver: () => ({
      observe(fact) {
        if (fact.kind === 'released') throw new Error('release observer failed');
      },
    }),
    bindInvocation: () => ({ observe() {} }),
  };
  const runner = new Runner(
    scene((work) => {
      if (work.input) throw original;
      return 'ok';
    }),
    new Resources(),
    undefined,
    { observations: [install] },
  ).build();
  await assert.rejects(runner.run(true), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0], original);
    assert.match(error.errors[1].message, /observation/i);
    return true;
  });
  assert.equal(runner.isRunning, false);
  assert.equal(await runner.run(false), 'ok');
});

test('Runner converts an unhandled declared result without confusing it with admission failure', async () => {
  const failure = new ExceptionContract('runner.expected-failure');
  const original = failure.create('unable to proceed', { retry: false });
  const root = new Scene({
    raises: [failure],
    run: {
      execute(work) {
        if (work.input) throw original;
        return 'ok';
      },
    },
  });
  const facts = [];
  const runner = new Runner(root, new Resources(), undefined, { observations: [observation(facts)] }).build();
  await assert.rejects(runner.run(true), (error) => error.code === 'UNHANDLED_EXCEPTION' && error.cause === original);
  assert.equal(runner.isRunning, false);
  assert.equal(await runner.run(false), 'ok');
  assert.equal(
    facts.some((fact) => fact.kind === 'entry-failed'),
    false,
  );
});

test('Runner host validation retains its receiver and rejects asynchronous admission', async () => {
  let executed = 0;
  const options = {
    validations: 0,
    validate(input) {
      this.validations++;
      if (input.async) return Promise.reject(new Error('late host validation'));
    },
  };
  const runner = new Runner(
    scene(() => {
      executed++;
      return 'ok';
    }),
    new Resources(),
    undefined,
    options,
  ).build();
  options.validate = () => assert.fail('replacement admission hook must not install');
  await assert.rejects(runner.run(null, { async: true }), /undefined synchronously/);
  assert.equal(runner.isRunning, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(executed, 0);
  assert.equal(await runner.run(null), 'ok');
  assert.equal(options.validations, 2);
});

test('child validation precedes capture while started factories still follow the fixed capture', async () => {
  const number = new ResourceOffer('runner.validated-capture', (value) => value);
  const child = new Node();
  child.setRun({ requires: { number: number.request() }, execute: (work) => work.resources.number });
  const root = new Scene().add(child);
  root.setRun({
    async execute(work) {
      const call = work.children.create(child, work.input);
      await call.run();
      return call.accept();
    },
  });
  const captured = [];
  const established = [];
  let snapshot;
  const resources = new Resources();
  resources
    .capture(child, (input) => {
      captured.push(input);
      snapshot = input;
      return input;
    })
    .register(number, (value) => value);
  const runner = new Runner(root, resources, undefined, {
    hooks: [
      callableHooks(child, {
        validate(input) {
          if (input < 0) throw new Error('invalid child input');
        },
        started(input) {
          assert.equal(snapshot, input);
          return () => {
            established.push(input);
          };
        },
      }),
    ],
  }).build();
  await assert.rejects(runner.run(-1), /invalid child input/);
  assert.deepEqual(captured, []);
  assert.deepEqual(established, []);
  assert.equal(await runner.run(3), 3);
  assert.deepEqual(captured, [3]);
  assert.deepEqual(established, [3]);
});

test('asynchronous host factories are rejected at construction and their rejected promises are consumed', async () => {
  for (const hook of ['started', 'progress', 'output']) {
    let executed = false;
    const root = scene(() => {
      executed = true;
    });
    const runner = new Runner(root, new Resources(), undefined, {
      hooks: [
        callableHooks(root, {
          [hook]: async () => {
            throw new Error(`late ${hook} factory failure`);
          },
        }),
      ],
    }).build();
    await assert.rejects(runner.run(null), new RegExp(`${hook} factory must be synchronous`));
    assert.equal(runner.isRunning, false);
    assert.equal(executed, false);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test('run and resume fix top-level options before delayed child capture without cloning host entities', async () => {
  for (const restore of [false, true]) {
    const entered = deferred();
    const proceed = deferred();
    const store = new MemoryCheckpointStore();
    const value = new ResourceOffer('runner.fixed-options', (captured) => captured);
    const child = new Node();
    child.setRun({ requires: { value: value.request() }, execute: (work) => work.resources.value });
    const root = new Scene().add(child);
    const delayed = async (work) => {
      entered.resolve();
      await proceed.promise;
      const call = work.children.create(child, null);
      await call.run();
      return call.accept();
    };
    const point = checkpointPoint()({ name: 'waiting', state: codec, references: {}, resume: { requires: {}, uses: [child], execute: delayed } });
    root.setDefinition({
      checkpoint: { key: 'runner.fixed-options', version: 1, input: codec, output: codec, points: [point] },
      run: { execute: delayed },
    });
    const entity = { state: 'initial' };
    const control = new AbortController();
    const hostOptions = { tenant: 'original', entity, signal: control.signal };
    const resources = new Resources();
    resources
      .capture(child, (_input, options) => {
        assert.notEqual(options, hostOptions);
        assert.equal(Object.isFrozen(options), true);
        assert.equal(options.tenant, 'original');
        assert.equal(options.entity, entity);
        assert.equal(options.signal, control.signal);
        assert.equal(options.entity.state, 'updated by host');
        assert.throws(() => {
          options.tenant = 'changed inside capture';
        }, TypeError);
        return options.tenant;
      })
      .register(value, (captured) => captured);
    const runner = new Runner(root, resources, undefined, { checkpoints: { store } }).build();
    if (restore)
      store.save(
        {
          id: 'runner-options-cp',
          formatVersion: 4,
          contract: { key: 'runner.fixed-options', version: 1 },
          point: 'waiting',
          frame: { owner: { contextId: 'runner-options-context', kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] },
          state: null,
          references: {},
        },
        0,
      );
    const pending = restore ? runner.resume('runner-options-context', hostOptions) : runner.run(null, hostOptions);
    await entered.promise;
    hostOptions.tenant = 'replacement';
    hostOptions.entity = { state: 'replacement entity' };
    hostOptions.signal = new AbortController().signal;
    entity.state = 'updated by host';
    assert.equal(Object.isFrozen(hostOptions), false);
    assert.equal(Object.isFrozen(entity), false);
    proceed.resolve();
    assert.equal(await pending, 'original');
    assert.equal(runner.isRunning, false);
  }
});
