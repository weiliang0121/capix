import { runtimeDefinition, recordDefinitions, recordedCall } from './fixtures/declarations.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutionDefinition, OperationDefinition, AttemptDefinition, InvocationEntry, Sequence, ResourceOffer, assembleRuntime, RuntimeBinder, Recorder, RecordBook, bindRecording } from '@capix/server-runtime';
import { createInvocationBuilders, resolveDeclaration, AttemptBinder, OperationBinder, ExecutionBinder, BoundChildren, BoundExecution, BoundOperation, BoundAttempt } from '@capix/server-runtime/construction';

const resource = new ResourceOffer('test.value', (value) => value, 'binding');
class Read extends AttemptDefinition {
  name = 'read';
  label = 'Read';
  source = 'test';
  callee = 'test';
  run = { requires: { value: resource.request() }, execute: this.execute.bind(this) };
  execute(context) {
    return `${context.currentInput}:${context.resources.values.value}`;
  }
}
class Work extends OperationDefinition {
  name = 'work';
  label = 'Work';
  source = 'test';
  run = { requires: { value: resource.request() }, execute: this.execute.bind(this) };
  leaf = new Read();
  children = [this.leaf];
  sequence = new Sequence().step('read', { use: this.leaf, input: ({ input }) => input });
  async execute(context, invocation, children) {
    return (await this.sequence.run(invocation, context.currentInput, children)).read;
  }
}
class Main extends ExecutionDefinition {
  run = { requires: { value: resource.request() }, execute: this.execute.bind(this) };
  operation = new Work();
  children = [this.operation];
  execute(context, invocation, children) {
    return children.get(this.operation).call(invocation, context.currentInput);
  }
}
function bind(main, source, options = {}) {
  const definition = runtimeDefinition(main);
  const observations = options.recorder ? [bindRecording(options.recorder, { failure: 'propagate' })] : undefined;
  if (observations) recordDefinitions(definition);
  return assembleRuntime(definition, { observations, providers: [resource.provide((value) => value)], source: { entry: () => source(), capture: () => source(), callbacks: (_definition, options) => options.execution } });
}

test('definitions bind to independent R endpoints; node identity is stable and per-call state is separate', async () => {
  const definition = new Main();
  let value = 'left';
  const firstRecorder = new Recorder(new RecordBook());
  const secondRecorder = new Recorder(new RecordBook());
  const first = bind(definition, () => value, { recorder: firstRecorder });
  const second = bind(definition, () => 'right', { recorder: secondRecorder });
  const calls = [];
  const callbacks = { started: (_context, invocation) => calls.push(invocation) };
  assert.equal(definition.runtime, undefined);
  assert.equal(definition.operation.id, undefined);
  assert.equal(first.context, undefined);
  assert.equal(await first.run('one', { execution: callbacks }), 'one:left');
  value = 'next';
  assert.equal(await first.run('two', { execution: callbacks }), 'two:next');
  assert.equal(await second.run('three', { execution: callbacks }), 'three:right');
  const identity = (call, recorder = firstRecorder) => recordedCall(recorder, call.children.values()[0].invocation).operationInstanceId;
  assert.equal(identity(calls[0]), identity(calls[1]));
  assert.notEqual(identity(calls[0]), identity(calls[2], secondRecorder));
  assert.notEqual(calls[0].context.id, calls[1].context.id);
  const parent = firstRecorder.book.get(recordedCall(firstRecorder, calls[0]).parentId);
  assert.equal(parent.kind, 'runtime-call');
  assert.equal(firstRecorder.book.get(parent.parentId).kind, 'runtime');
  assert.equal(first.running, false);
});

test('one RuntimeBinder binds independent roots and rejects transferring a live child entry across them', async () => {
  const execution = new Main();
  const definition = runtimeDefinition(execution);
  const binder = new RuntimeBinder();
  const calls = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let previous;
  execution.run.execute = async (context, invocation, children) => {
    const child = children.get(execution.operation);
    if (context.currentInput === 'left') {
      previous = child;
      await pending;
      return context.currentInput;
    }
    if (context.currentInput === 'right') {
      assert.throws(() => previous.create(invocation, 'foreign'), /another parent invocation/);
      assert.equal(invocation.children.values().length, 0);
    }
    return child.call(invocation, context.currentInput);
  };
  const options = (value) => ({
    providers: [resource.provide((source) => source)],
    source: { entry: () => value, capture: () => value, callbacks: () => ({ started: (_context, invocation) => calls.push(invocation) }) },
  });
  const left = binder.bind(definition, options('left-resource'));
  const right = binder.bind(definition, options('right-resource'));
  assert.notEqual(left.id, right.id);
  const leftRun = left.run('left', {});
  const leftFailure = assert.rejects(leftRun, /another parent invocation/);
  assert.equal(left.running, true);
  try {
    assert.equal(await right.run('right', {}), 'right:right-resource');
    assert.notEqual(calls[0].context.id, calls[1].context.id);
    assert.equal(calls[0].children.values().length, 0);
    assert.equal(calls[1].children.values().length, 1);
  } finally {
    release();
    await leftFailure;
  }
  assert.equal(left.running, false);
  assert.equal(right.running, false);
  assert.equal(await left.run('next', {}), 'next:left-resource');
});

test('business views exclude state mutation, records, binding APIs and relation mutation', async () => {
  const definition = new Main();
  const original = definition.operation.run.execute;
  definition.operation.run.execute = async function (context, invocation, children) {
    assert.equal(context.complete, undefined);
    assert.equal(context.fail, undefined);
    assert.equal(context.startRound, undefined);
    assert.equal(context.resources.select, undefined);
    assert.equal(invocation.record, undefined);
    assert.equal(invocation.source, undefined);
    assert.equal(invocation.run, undefined);
    assert.equal(invocation.children.attach, undefined);
    assert.ok(Object.isFrozen(context));
    const result = await original.call(this, context, invocation, children);
    const relation = invocation.children.values()[0];
    assert.equal(relation.accept, undefined);
    assert.equal(relation.returnedWith, undefined);
    assert.equal(relation.invocation.context.complete, undefined);
    assert.equal(relation.invocation.context.resources, undefined);
    assert.equal(relation.invocation.record, undefined);
    assert.equal(relation.invocation.run, undefined);
    assert.equal(invocation.children.get(relation.invocation), relation);
    assert.equal(relation.reception.status, 'accepted');
    assert.equal(invocation.origin.contextId, context.id);
    return result;
  };
  assert.equal(await bind(definition, () => 'value').run('input', {}), 'input:value');
});

test('plain definitions use the same fixed structures without class inheritance', async () => {
  const child = { level: 'operation', name: 'length', label: 'Length', source: 'test', children: [], maxRounds: 1, raises: [], run: { requires: {}, execute: (context) => context.currentInput.length } };
  const execution = { level: 'execution', children: [child], maxRounds: 1, raises: [], run: { requires: {}, execute: (context, invocation, children) => children.get(child).call(invocation, context.currentInput) } };
  const runtime = assembleRuntime(runtimeDefinition(execution), { providers: [], source: { entry: () => null, capture: () => null } });
  assert.equal(await runtime.run('hello', {}), 5);
});

test('a call-scoped child entry cannot be transferred to another parent', async () => {
  const definition = new Main();
  let previous;
  let previousAlternative;
  let previousInvocation;
  let accepted = 0;
  const alternative = new InvocationEntry(definition.operation, (_parent, input) => {
    accepted++;
    return input;
  });
  definition.run.execute = async function (context, invocation, children) {
    const child = children.get(definition.operation);
    if (previous) {
      assert.throws(() => previous.create(invocation, 'wrong'), /another parent invocation/);
      assert.throws(() => previousAlternative.create(invocation, 'wrong'), /another parent invocation/);
      assert.equal(accepted, 0);
      assert.equal(invocation.children.values().length, 0);
    }
    previous = child;
    previousAlternative = children.entry(alternative);
    previousInvocation = invocation;
    return child.call(invocation, context.currentInput);
  };
  const runtime = bind(definition, () => 'resource');
  await runtime.run('first', {});
  await runtime.run('second', {});
  assert.throws(() => previousAlternative.create(previousInvocation, 'ended'), /already ended/);
  assert.equal(accepted, 0);
});

test('undeclared entries fail before admission and attachment', async () => {
  const definition = new Main();
  const unknown = new Work();
  let accepted = false;
  const alternative = new InvocationEntry(unknown, () => {
    accepted = true;
    return 'wrong';
  });
  definition.run.execute = (_context, invocation, children) => {
    assert.throws(() => children.get(unknown), /not declared/);
    assert.throws(() => children.entry(alternative).create(invocation, null), /not declared/);
    assert.equal(invocation.children.values().length, 0);
    return 'done';
  };
  await assert.rejects(bind(definition, () => 'value').run(null, {}), /not declared/);
  assert.equal(accepted, false);
});

test('assembly rejects invalid levels and cycles without activating resource providers', () => {
  const main = new Main();
  main.children = [new Read()];
  assert.throws(() => bind(main, () => assert.fail('not yet')), /Invalid child definition level/);
  main.children = [main.operation];
  main.operation.children = [main.operation];
  assert.throws(() => bind(main, () => assert.fail('not yet')), /Cyclic child declaration/);
});

test('nested O structures stay lazy and a shared A declaration is bound independently at each parent position', () => {
  const shared = new Read();
  const left = new Work();
  left.children = [shared];
  const right = new Work();
  right.children = [shared];
  const group = new Work();
  group.children = [left, right];
  const main = new Main();
  main.children = [group];
  const builders = createInvocationBuilders();
  const attemptBinder = new AttemptBinder(builders.attempt);
  const operationBinder = new OperationBinder(builders.operation, attemptBinder);
  const executionBinder = new ExecutionBinder(builders.execution, operationBinder);
  const roots = new BoundChildren([resolveDeclaration(main)], (resolved) => executionBinder.bindResolved(resolved));

  assert.equal(roots.initialized(main), false);
  const execution = roots.get(main);
  assert.ok(execution instanceof BoundExecution);
  assert.equal(execution.children.initialized(group), false);
  const operation = execution.children.get(group);
  assert.ok(operation instanceof BoundOperation);
  assert.equal(operation.children.initialized(left), false);
  assert.equal(operation.children.initialized(right), false);

  const first = operation.children.get(left);
  assert.ok(first instanceof BoundOperation);
  assert.equal(first.children.initialized(shared), false);
  assert.equal(operation.children.initialized(right), false);
  const firstLeaf = first.children.get(shared);
  assert.ok(firstLeaf instanceof BoundAttempt);
  assert.equal(first.children.get(shared), firstLeaf);

  const second = operation.children.get(right);
  assert.equal(second.children.initialized(shared), false);
  const secondLeaf = second.children.get(shared);
  assert.ok(secondLeaf instanceof BoundAttempt);
  assert.notEqual(firstLeaf, secondLeaf);
  assert.equal(roots.get(main), execution);
  assert.equal(execution.children.get(group), operation);
});

test('E entry ordering is reserve, validate, accept, accepted, admit, capture, started, work', async () => {
  const order = [];
  const execution = new Main();
  execution.entry = {
    requires: {},
    accept: (input) => {
      order.push('accept');
      return input;
    },
    admit: () => order.push('admit'),
  };
  execution.run.execute = (context) => {
    order.push('work');
    return context.currentInput;
  };
  const runtime = assembleRuntime(runtimeDefinition(execution), {
    providers: [resource.provide((value) => value)],
    source: {
      validate: () => {
        assert.equal(runtime.running, true);
        order.push('validate');
      },
      entry: () => 'value',
      callbacks: (_definition, options) => options.execution,
      capture: () => {
        order.push('capture');
        return 'value';
      },
    },
  });
  await runtime.run('input', { execution: { accepted: () => order.push('accepted'), started: () => order.push('started') } });
  assert.deepEqual(order, ['validate', 'accept', 'accepted', 'admit', 'capture', 'started', 'work']);
  assert.equal(runtime.running, false);
});

test('pre-cancelled R skips E admission; capture failure releases R reservation', async () => {
  const order = [];
  const execution = new Main();
  execution.entry = {
    requires: {},
    accept: (input) => {
      order.push('accept');
      return input;
    },
    admit: () => order.push('admit'),
  };
  const runtime = bind(execution, () => 'value');
  await assert.rejects(runtime.run('input', { signal: AbortSignal.abort(), execution: { accepted: () => order.push('accepted') } }), /取消/);
  assert.deepEqual(order, []);
  const failure = new Error('capture failed');
  const broken = assembleRuntime(runtimeDefinition(execution), {
    providers: [resource.provide((value) => value)],
    source: {
      entry: () => 'value',
      callbacks: (_definition, options) => options.execution,
      capture: () => {
        throw failure;
      },
    },
  });
  await assert.rejects(broken.run('input', {}), (error) => error === failure);
  assert.equal(broken.running, false);
});

test('entry endpoints expire before work and also expire when acceptance fails', async () => {
  const access = new ResourceOffer('test.entry', (_source, activity) => ({ touch: () => activity.runSync('touch', {}, () => 'value') }));
  for (const fails of [false, true]) {
    let saved;
    const main = new Main();
    main.entry = {
      requires: { access: access.request() },
      accept(input, resources) {
        saved = resources.access;
        assert.equal(saved.touch(), 'value');
        if (fails) throw new Error('entry failed');
        return input;
      },
      admit() {
        assert.equal(saved.touch(), 'value');
      },
    };
    main.run.execute = () => 'done';
    const runtime = assembleRuntime(runtimeDefinition(main), {
      providers: [access.provide(() => null), resource.provide(() => 'value')],
      source: {
        entry: () => null,
        capture: () => {
          assert.throws(() => saved.touch(), /entry access has ended/);
          return null;
        },
      },
    });
    if (fails) await assert.rejects(runtime.run('input', {}), /entry failed/);
    else await assert.rejects(runtime.run('input', {}), /entry access has ended/);
    assert.throws(() => saved.touch(), fails ? /entry failed/ : /entry access has ended/);
    assert.equal(runtime.running, false);
  }
});
