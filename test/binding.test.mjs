import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutionDefinition, OperationDefinition, AttemptDefinition, InvocationEntry, Sequence, ResourceOffer, assembleRuntime, Recorder, RecordBook } from '@capix-observer/runtime';

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
  return assembleRuntime({ execution: main }, { ...options, providers: [resource.provide((value) => value)], source: { entry: () => source(), capture: () => source() } });
}

test('definitions bind to independent R endpoints; node identity is stable and per-call state is separate', async () => {
  const definition = new Main();
  let value = 'left';
  const first = bind(definition, () => value, { recorder: new Recorder(new RecordBook()) });
  const second = bind(definition, () => 'right', { recorder: new Recorder(new RecordBook()) });
  const calls = [];
  const callbacks = { started: (_context, invocation) => calls.push(invocation) };
  assert.equal(definition.runtime, undefined);
  assert.equal(definition.operation.id, undefined);
  assert.equal(first.context.transcript, undefined);
  assert.equal(first.context.memories, undefined);
  assert.equal(await first.run('one', {}, callbacks), 'one:left');
  value = 'next';
  assert.equal(await first.run('two', {}, callbacks), 'two:next');
  assert.equal(await second.run('three', {}, callbacks), 'three:right');
  const identity = (call) => call.children.values()[0].invocation.record.operationInstanceId;
  assert.equal(identity(calls[0]), identity(calls[1]));
  assert.notEqual(identity(calls[0]), identity(calls[2]));
  assert.notEqual(calls[0].context.id, calls[1].context.id);
  assert.equal(calls[0].record.parentId, first.record.id);
  assert.equal(first.running, false);
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
  const runtime = assembleRuntime({ execution }, { providers: [], source: { entry: () => null, capture: () => null } });
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
  const runtime = assembleRuntime(
    { execution },
    {
      providers: [resource.provide((value) => value)],
      source: {
        validate: () => {
          assert.equal(runtime.running, true);
          order.push('validate');
        },
        entry: () => 'value',
        capture: () => {
          order.push('capture');
          return 'value';
        },
      },
    },
  );
  await runtime.run('input', {}, { accepted: () => order.push('accepted'), started: () => order.push('started') });
  assert.deepEqual(order, ['validate', 'accept', 'accepted', 'admit', 'capture', 'started', 'work']);
  assert.equal(runtime.context.running, false);
});

test('cancelled input is accepted but skips admit; capture failure releases R reservation', async () => {
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
  await assert.rejects(runtime.run('input', { signal: AbortSignal.abort() }, { accepted: () => order.push('accepted') }), /取消/);
  assert.deepEqual(order, ['accept', 'accepted']);
  const failure = new Error('capture failed');
  const broken = assembleRuntime(
    { execution },
    {
      providers: [resource.provide((value) => value)],
      source: {
        entry: () => 'value',
        capture: () => {
          throw failure;
        },
      },
    },
  );
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
    const runtime = assembleRuntime(
      { execution: main },
      {
        providers: [access.provide(() => null), resource.provide(() => 'value')],
        source: {
          entry: () => null,
          capture: () => {
            assert.throws(() => saved.touch(), /entry access has ended/);
            return null;
          },
        },
      },
    );
    if (fails) await assert.rejects(runtime.run('input', {}), /entry failed/);
    else assert.equal(await runtime.run('input', {}), 'done');
    assert.throws(() => saved.touch(), /entry access has ended/);
    assert.equal(runtime.running, false);
  }
});
