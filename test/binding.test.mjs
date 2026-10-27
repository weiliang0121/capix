import { ResourceAccessClosed } from '@capix/resources';
import { installCallable } from './fixtures/driver.mjs';
import { runtimeDefinition, recordedCall } from './fixtures/declarations.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Group, Node, Driver, bindCallSource, bindRecording } from '@capix/server-runtime';
import { Recorder, RecordBook } from '@capix/records';
import { ResourceOffer } from '@capix/resources';
import { buildCallableFromSource, callableConstruction } from '@capix/server-runtime/construction';

const resource = new ResourceOffer({ name: 'test.value', expose: (value) => value, timing: 'binding' });
class Read extends Node {
  name = 'read';
  label = 'Read';
  source = 'test';
  deps = { value: resource.request() };
  run = this.execute.bind(this);
  execute(work) {
    return `${work.input}:${work.resources.value}`;
  }
}
class Work extends Group {
  name = 'work';
  label = 'Work';
  source = 'test';
  deps = { value: resource.request() };
  run = this.execute.bind(this);
  leaf = new Read();
  constructor() {
    super();
    this.add(this.leaf);
  }
  async execute(work) {
    return work.children.invoke(this.leaf, work.input);
  }
}
class Main extends Group {
  deps = { value: resource.request() };
  run = this.execute.bind(this);
  operation = new Work();
  constructor() {
    super();
    this.add(this.operation);
  }
  async execute(work) {
    const child = work.children.create(this.operation, work.input);
    await child.run();
    return child.accept();
  }
}
function bind(main, source, options = {}) {
  const definition = runtimeDefinition(main);
  const observations = options.recorder ? [bindRecording(options.recorder, { failure: 'propagate' })] : undefined;
  return installCallable(definition, { observations, providers: [resource.provide((value) => value)], source: { capture: () => source() }, bindings: [bindCallSource(main, { started: (options) => options.execution?.started })] });
}

test('independent structure instances have stable identities and separate per-call state', async () => {
  const definition = new Main();
  let value = 'left';
  const firstRecorder = new Recorder(new RecordBook());
  const secondRecorder = new Recorder(new RecordBook());
  const first = bind(definition, () => value, { recorder: firstRecorder });
  const second = bind(new Main(), () => 'right', { recorder: secondRecorder });
  const calls = [];
  const callbacks = {
    started: (_context, invocation) => {
      calls.push(invocation);
    },
  };
  assert.equal(definition.runtime, undefined);
  assert.equal(typeof definition.operation.id, 'string');
  assert.equal(first.context, undefined);
  assert.equal(await first.run('one', { execution: callbacks }), 'one:left');
  value = 'next';
  assert.equal(await first.run('two', { execution: callbacks }), 'two:next');
  assert.equal(await second.run('three', { execution: callbacks }), 'three:right');
  const identity = (call, recorder = firstRecorder) => recordedCall(recorder, call.children.values()[0].invocation).structureId;
  assert.equal(identity(calls[0]), identity(calls[1]));
  assert.notEqual(identity(calls[0]), identity(calls[2], secondRecorder));
  assert.notEqual(calls[0].context.id, calls[1].context.id);
  const parent = firstRecorder.book.get(recordedCall(firstRecorder, calls[0]).parentId);
  assert.equal(parent.kind, 'invocation');
  assert.equal(firstRecorder.book.get(parent.parentId).kind, 'runtime');
  assert.equal(first.running, false);
});

test('one Driver builds independent roots and rejects foreign child references', async () => {
  const driver = new Driver();
  const calls = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let previous;
  let established;
  const ready = new Promise((resolve) => {
    established = resolve;
  });
  const createExecution = () => {
    const execution = new Main();
    execution.run = async (work) => {
      if (work.input === 'right') return work.children.open(previous).run();
      const child = work.children.create(execution.operation, work.input);
      await child.run();
      if (work.input === 'left') {
        previous = child.ref;
        established();
        await pending;
      }
      return child.accept();
    };
    return execution;
  };
  const options = (execution, value) => ({
    providers: [resource.provide((source) => source)],
    source: {
      capture: () => value,
    },
    bindings: [
      bindCallSource(execution, {
        started: () => (_context, invocation) => {
          calls.push(invocation);
        },
      }),
    ],
  });
  const leftExecution = createExecution();
  const rightExecution = createExecution();
  const left = driver.build(runtimeDefinition(leftExecution), options(leftExecution, 'left-resource'));
  const right = driver.build(runtimeDefinition(rightExecution), options(rightExecution, 'right-resource'));
  assert.notEqual(left.id, right.id);
  const leftRun = driver.run(left, 'left', {});
  await ready;
  assert.ok(previous);
  try {
    assert.equal(driver.isRunning(left), true);
    await assert.rejects(driver.run(right, 'right', {}), /foreign child reference/);
    assert.notEqual(calls[0].context.id, calls[1].context.id);
    assert.equal(calls[0].children.values().length, 1);
    assert.equal(calls[1].children.values().length, 0);
  } finally {
    release();
  }
  assert.equal(await leftRun, 'left:left-resource');
  assert.equal(driver.isRunning(left), false);
  assert.equal(driver.isRunning(right), false);
  assert.equal(await driver.run(left, 'next', {}), 'next:left-resource');
});

test('business Work and child facts exclude lifecycle, binding and relation mutation', async () => {
  const definition = new Main();
  const original = definition.operation.run;
  definition.operation.run = async function (work) {
    for (const name of ['context', 'invocation', 'complete', 'fail', 'startRound', 'record', 'source', 'run']) assert.equal(work[name], undefined);
    assert.equal(work.resources.select, undefined);
    assert.equal(work.children.attach, undefined);
    assert.ok(Object.isFrozen(work));
    const result = await original.call(this, work);
    const fact = work.children.facts.values()[0];
    for (const name of ['invocation', 'accept', 'returnedWith', 'context', 'record', 'run']) assert.equal(fact[name], undefined);
    assert.ok(Object.isFrozen(fact));
    assert.equal(work.children.facts.get(fact.ref).ref, fact.ref);
    assert.equal(fact.reception.status, 'accepted');
    return result;
  };
  assert.equal(await bind(definition, () => 'value').run('input', {}), 'input:value');
});

test('plain configurations build concrete structures without business subclassing', async () => {
  const child = new Group({ name: 'length', label: 'Length', source: 'test', deps: {}, run: (work) => work.input.length });
  const execution = new Group({
    deps: {},
    run: async (work) => {
      const call = work.children.create(child, work.input);
      await call.run();
      return call.accept();
    },
  }).add(child);
  const runtime = installCallable(runtimeDefinition(execution), { providers: [], source: { capture: () => null } });
  assert.equal(await runtime.run('hello', {}), 5);
});

test('a completed parent cannot create or invoke children even after ordinary input preparation', async () => {
  const definition = new Main();
  let previous;
  let prepared = 0;
  const prepare = (input) => {
    prepared++;
    return input;
  };
  definition.run = async function (work) {
    previous = work.children;
    const child = work.children.create(definition.operation, work.input);
    await child.run();
    return child.accept();
  };
  const runtime = bind(definition, () => 'resource');
  await runtime.run('first', {});
  assert.throws(() => previous.create(definition.operation, 'ended'), /already ended/);
  const input = prepare('ended');
  await assert.rejects(previous.invoke(definition.operation, input), /already ended/);
  assert.equal(prepared, 1, 'plain input preparation is ordinary business code, outside the call window guard');
  assert.equal(await runtime.run('second', {}), 'second:resource');
});

test('undeclared children fail before attachment or execution through create and invoke', async () => {
  const definition = new Main();
  const unknown = new Work();
  let executed = false;
  unknown.run = () => {
    executed = true;
    return 'wrong';
  };
  definition.run = async (work) => {
    assert.throws(() => work.children.create(unknown, null), /not declared/);
    await assert.rejects(work.children.invoke(unknown, null), /not declared/);
    assert.equal(work.children.facts.values().length, 0);
    return 'done';
  };
  await assert.rejects(bind(definition, () => 'value').run(null, {}), /not declared/);
  assert.equal(executed, false);
});

test('assembly rejects invalid levels and cycles without activating resource providers', () => {
  const main = new Main();
  assert.throws(() => main.add(runtimeDefinition(new Main())), /member|kind|scene/i);
  assert.throws(() => main.operation.add(main), /cyclic/i);
  Object.defineProperty(main.operation, 'members', { value: [main.operation], configurable: true });
  assert.throws(() => bind(main, () => assert.fail('not yet')), /cyclic|parent|registered/i);
});

test('building nested structures retains exact member identities without opening resources', () => {
  const left = new Work();
  const right = new Work();
  const group = new Group({ run: () => null }).add(left, right);
  const main = new Group({ run: () => null }).add(group);
  const definition = runtimeDefinition(main);
  const scene = buildCallableFromSource(definition, { providers: [resource.provide(() => assert.fail('build cannot open resources'))], source: { capture: () => assert.fail('build cannot capture input') } });
  assert.equal(scene, definition);
  const children = (structure) => callableConstruction(structure).binding.children;
  assert.equal(children(scene).get(main), main);
  assert.equal(children(main).get(group), group);
  assert.equal(children(group).get(left), left);
  assert.equal(children(group).get(right), right);
  assert.equal(children(left).get(left.leaf), left.leaf);
  assert.equal(children(right).get(right.leaf), right.leaf);
  assert.notEqual(left.leaf, right.leaf);
  assert.equal(children(left).get(left.leaf), left.leaf);
});

test('E construction follows R reservation, validation, ordinary input preparation, capture and started', async () => {
  const order = [];
  const execution = new Main();
  execution.run = (work) => {
    order.push('work');
    return work.input;
  };
  const definition = runtimeDefinition(execution);
  definition.run = async (work) => {
    order.push('prepare');
    const child = work.children.create(execution, { text: work.input });
    await child.run();
    return child.accept();
  };
  const runtime = installCallable(definition, {
    providers: [resource.provide((value) => value)],
    source: {
      validate: () => {
        assert.equal(runtime.running, true);
        order.push('validate');
      },
      capture: () => 'root',
    },
    bindings: [
      bindCallSource(execution, {
        started: (options) => options.execution?.started,
        capture: (input) => {
          order.push('capture');
          assert.deepEqual(input, { text: 'input' });
          return 'value';
        },
      }),
    ],
  });
  assert.deepEqual(
    await runtime.run('input', {
      execution: {
        started: () => {
          order.push('started');
        },
      },
    }),
    { text: 'input' },
  );
  assert.deepEqual(order, ['validate', 'prepare', 'capture', 'started', 'work']);
  assert.equal(runtime.running, false);
});

test('pre-cancelled R skips E capture; capture failure releases R reservation', async () => {
  let captures = 0;
  const execution = new Main();
  const runtime = bind(execution, () => {
    captures++;
    return 'value';
  });
  await assert.rejects(runtime.run('input', { signal: AbortSignal.abort() }), /取消/);
  assert.equal(captures, 0);
  const failure = new Error('capture failed');
  const broken = installCallable(runtimeDefinition(new Main()), {
    providers: [resource.provide((value) => value)],
    source: {
      capture: () => {
        throw failure;
      },
    },
  });
  await assert.rejects(broken.run('input', {}), (error) => error === failure);
  assert.equal(broken.running, false);
});

test('R resource endpoints remain scoped to R while E receives its own resource window', async () => {
  const access = new ResourceOffer({ name: 'test.input', expose: (_source, activity) => ({ touch: () => activity.runSync('touch', {}, () => 'value') }) });
  let saved;
  const main = new Main();
  main.run = () => {
    assert.equal(saved.touch(), 'value');
    return 'done';
  };
  const definition = runtimeDefinition(main);
  definition.deps = { access: access.request() };
  definition.run = async function (work) {
    saved = work.resources.access;
    const input = saved.touch();
    const child = work.children.create(main, input);
    await child.run();
    return child.accept();
  };
  const runtime = installCallable(definition, {
    providers: [access.provide(() => null), resource.provide(() => 'value')],
    source: { runtime: () => null, capture: () => null },
  });
  assert.equal(await runtime.run('input', {}), 'done');
  assert.throws(() => saved.touch(), ResourceAccessClosed);
  assert.equal(runtime.running, false);
});
