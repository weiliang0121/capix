import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecutionDefinition, OperationDefinition, AttemptDefinition, InvocationEntry, Sequence, ResourceOffer, createRuntime, Recorder, RecordBook } from '@capix-observer/runtime';
import { ObserverBinding, ObserverRuntimeDefinition } from '@capix-observer/service';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const resource = new ResourceOffer('test.value', (value) => value, 'binding');

class Read extends AttemptDefinition {
  name = 'read';
  label = 'Read';
  source = 'test';
  callee = 'test';
  requires = { value: resource.request() };
  execute(context) {
    return `${context.currentInput}:${context.resources.values.value}`;
  }
}
class Work extends OperationDefinition {
  name = 'work';
  label = 'Work';
  source = 'test';
  requires = { value: resource.request() };
  leaf = new Read();
  children = [this.leaf];
  sequence = new Sequence().step('read', { use: this.leaf, input: ({ input }) => input });
  async execute(context, invocation, children) {
    return (await this.sequence.run(invocation, context.currentInput, children)).read;
  }
}
class Main extends ExecutionDefinition {
  requires = { value: resource.request() };
  operation = new Work();
  children = [this.operation];
  execute(context, invocation, children) {
    return children.get(this.operation).call(invocation, context.currentInput);
  }
}
function bind(runtime, main, source) {
  return runtime.bind({ providers: [resource.provide((value) => value)], executions: { main } }).execution('main', {
    capture: () => ({ source: source() }),
  });
}

test('the same REOA definitions bind to independent runtimes and preserve per-binding operation identity', async () => {
  const definition = new Main();
  const left = createRuntime({ recorder: new Recorder(new RecordBook()) });
  const right = createRuntime({ recorder: new Recorder(new RecordBook()) });
  let value = 'left';
  const first = bind(left, definition, () => value);
  const second = bind(right, definition, () => 'right');
  assert.equal(definition.runtime, undefined);
  assert.equal(definition.operation.id, undefined);
  assert.equal(definition.operation.call, undefined);
  assert.equal(first.children.initialized(definition.operation), false);
  const calls = [];
  assert.equal(await first.call('one', {}, (_context, invocation) => calls.push(invocation)), 'one:left');
  const firstIdentity = first.children.get(definition.operation).id;
  value = 'next';
  assert.equal(await first.call('two', {}, (_context, invocation) => calls.push(invocation)), 'two:next');
  assert.equal(await second.call('three', {}), 'three:right');
  assert.equal(first.children.get(definition.operation).id, firstIdentity);
  assert.notEqual(second.children.get(definition.operation).id, firstIdentity);
  assert.equal(calls[0].context.resources.values.value, 'left');
  assert.equal(calls[1].context.resources.values.value, 'next');
  assert.notEqual(calls[0].context.id, calls[1].context.id);
  assert.equal(calls[0].record.value.settings, null);
  assert.equal(calls[0].record.parentId, left.record.id);
  assert.equal(calls[0].children.values()[0].invocation.record.operationInstanceId, firstIdentity);
});

test('definitions may be plain contract objects without inheriting a runtime class', async () => {
  const child = {
    level: 'operation',
    name: 'length',
    label: 'Length',
    source: 'test',
    requires: {},
    children: [],
    maxRounds: 1,
    execute: (context) => context.currentInput.length,
  };
  const root = {
    level: 'execution',
    requires: {},
    children: [child],
    maxRounds: 1,
    execute: (context, invocation, children) => children.get(child).call(invocation, context.currentInput),
  };
  const runtime = createRuntime();
  const entry = runtime.bind({ providers: [], executions: { root } }).execution('root', { capture: () => ({ source: null }) });
  assert.equal(await entry.call('hello', {}), 5);
});

test('a call-scoped child entry cannot be reused against a different parent, even in the same runtime', async () => {
  const definition = new Main();
  let previous;
  let previousAlternative;
  let previousInvocation;
  let accepted = 0;
  const alternative = new InvocationEntry(definition.operation, (_parent, input) => {
    accepted++;
    return input;
  });
  let calls = 0;
  definition.execute = async function (context, invocation, children) {
    const child = children.get(this.operation);
    if (previous) {
      const before = invocation.children.values().length;
      await assert.rejects(previous.call(invocation, 'wrong'), /another parent invocation/);
      assert.throws(() => previousAlternative.create(invocation, 'wrong'), /another parent invocation/);
      assert.equal(accepted, 0);
      assert.equal(invocation.children.values().length, before);
    }
    previous = child;
    previousAlternative = children.entry(alternative);
    previousInvocation = invocation;
    calls++;
    return child.call(invocation, context.currentInput);
  };
  const entry = bind(createRuntime(), definition, () => 'resource');
  await entry.call('first', {});
  await entry.call('second', {});
  assert.throws(() => previousAlternative.create(previousInvocation, 'ended'), /already ended/);
  assert.equal(accepted, 0);
  assert.equal(calls, 2);
});

test('undeclared definitions and alternative entries fail before application admission or child attachment', async () => {
  const definition = new Main();
  const unknown = new Work();
  let accepted = 0;
  const alternative = new InvocationEntry(unknown, () => {
    accepted++;
    return 'wrong';
  });
  definition.execute = async (_context, invocation, children) => {
    assert.throws(() => children.get(unknown), /not declared/);
    assert.throws(() => children.entry(alternative).create(invocation, null), /not declared/);
    assert.equal(invocation.children.values().length, 0);
    return 'done';
  };
  assert.equal(await bind(createRuntime(), definition, () => 'value').call(null, {}), 'done');
  assert.equal(accepted, 0);
});

test('binding rejects E-to-A and cyclic declarations before runtime identities or providers are used', () => {
  const runtime = createRuntime();
  const main = new Main();
  main.children = [new Read()];
  assert.throws(() => bind(runtime, main, () => assert.fail('not yet')), /Invalid child definition level/);
  main.children = [main.operation];
  main.operation.children = [main.operation];
  assert.throws(() => bind(runtime, main, () => assert.fail('not yet')), /Cyclic child declaration/);
});

test('binding captures inside runtime reservation after acceptance and releases on capture failure', async () => {
  const runtime = createRuntime();
  const definition = new Main();
  let accepted = false;
  const failure = new Error('capture failed');
  const entry = runtime.bind({ providers: [resource.provide((value) => value)], executions: { main: definition } }).execution('main', {
    capture: (input) => {
      assert.equal(runtime.running, true);
      assert.equal(accepted, true);
      assert.equal(input, 'input');
      throw failure;
    },
  });
  await assert.rejects(
    entry.submit(() => {
      accepted = true;
      return 'input';
    }, {}),
    (error) => error === failure,
  );
  assert.equal(runtime.running, false);
  assert.equal(entry.children.initialized(definition.operation), false);
});

test('one service definition can supply separate lazy model instances and independent conversation delivery', async () => {
  let created = 0;
  const definition = new ObserverRuntimeDefinition(() => {
    const instance = ++created;
    return { invoke: async (_request, purpose) => ({ id: String(instance), model: 'fixture', finishReason: 'stop', usage: null, content: JSON.stringify(purpose === 'selection' ? { historyIndexes: [] } : purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: `answer ${instance}` }) }) };
  });
  const first = new ObserverBinding(createRuntime(), definition);
  const second = new ObserverBinding(createRuntime(), definition);
  assert.equal(created, 0);
  const delivered = [[], []];
  await Promise.all(
    [first, second].map((binding, index) =>
      binding.converse(
        () => {
          binding.runtime.context.transcript.append({ role: 'user', content: 'hello' });
          return binding.runtime.context.transcript.current('user');
        },
        { settings },
        (value) => delivered[index].push(value),
      ),
    ),
  );
  assert.equal(created, 2);
  assert.deepEqual(
    delivered.map((values) => values.map((value) => value.type)),
    [
      ['started', 'answer', 'completed'],
      ['started', 'answer', 'completed'],
    ],
  );
  assert.notEqual(delivered[0][0].contextId, delivered[1][0].contextId);
  assert.notEqual(delivered[0][1].output.content, delivered[1][1].output.content);
  assert.equal(first.runtime.context.transcript.length, 2);
  assert.equal(second.runtime.context.transcript.length, 2);
});
