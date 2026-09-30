import { RuntimeRecordHelper } from '@capix-observer/runtime';
import { callFor, recordFor } from './fixtures/lifecycle.mjs';
import { subscribeExecutions } from '@capix-observer/service';
import { lifecycleFor } from './fixtures/lifecycle.mjs';
import { readOutput, validateSnapshot } from '@capix-observer/protocol';
import { createInput, observeFixture } from './fixtures/observer.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Recorder, BaseRecord, ExecutionRecord, OperationRecord, RecordBook, ExecutionRecordHelper, OperationRecordHelper, Clock, RuntimeError, createRuntime } from '@capix-observer/runtime';
import { test } from 'node:test';

import { TestOperation } from './fixtures/operation.mjs';

import { projectExecution } from '../apps/observer/.test-dist/observation/project.js';

const settings = { model: 'test', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const input = { content: '她呢', history: [{ role: 'user', content: '林岚负责海盐项目' }] };
const identity = (value) => value;
const echo = { load: identity, transform: identity, accept: identity };
const output = (content) => ({
  id: 'model',
  model: 'test',
  content,
  finishReason: 'stop',
  usage: null,
});
async function execute(answer = '{"kind":"answer","content":"海盐项目"}') {
  const responses = [output('{"historyIndexes":[0]}'), output(answer), output('{"memories":[]}')];
  return observeFixture(createInput(input), settings, {
    async invoke() {
      return responses.shift();
    },
  });
}
const createRecordedRuntime = (publish) => {
  const runtime = createRuntime({ recorder: new Recorder(new RecordBook(), new Clock()) });
  if (publish) subscribeExecutions(runtime.recording, publish);
  return runtime;
};
const lifecycles = new WeakMap();
const begin = (runtime, value = input) => {
  const lifecycle = lifecycleFor(runtime).execution({ input: value, settings });
  const context = lifecycle.begin();
  lifecycles.set(context, lifecycle);
  return context;
};
const complete = (context, output) => lifecycles.get(context).succeed(context, output);

test('Book stores any record by identity without creating invocation boundaries', () => {
  const book = new RecordBook();
  const value = { material: 'reference' };
  const record = new BaseRecord(value);
  assert.deepEqual(Object.getOwnPropertyNames(RecordBook.prototype).sort(), ['add', 'constructor', 'get', 'values']);
  assert.equal('status' in record, false);
  assert.equal(book.add(record), record);
  assert.equal(book.get(record.id), record);
  assert.equal(book.get(record.id).value, value);
  assert.equal(book.get('missing'), undefined);
  assert.deepEqual([...book.values()], [record]);

  assert.throws(() => book.add(record), /already exists/);
  const conflict = new BaseRecord({ material: 'replacement' });
  Object.defineProperty(conflict, 'id', { value: record.id });
  assert.throws(() => book.add(conflict), /already exists/);
  assert.equal(book.get(record.id), record);
  assert.equal([...book.values()].length, 1);
});

test('Paired record operations create, find and write results independently of boundary bookkeeping', () => {
  const book = new RecordBook();
  const clock = new Clock();
  const root = RuntimeRecordHelper.create(new Recorder(book));
  const execution = ExecutionRecordHelper.create(new Recorder(book), clock, randomUUID(), { input, settings }, root.id);
  const other = ExecutionRecordHelper.create(new Recorder(book), clock, randomUUID(), { input, settings }, root.id);
  const def = {
    contextId: randomUUID(),
    executionId: execution.id,
    operationInstanceId: 'n',
    operation: 'echo',
    label: 'echo',
    source: 'test',
    caller: 'execution',
    callee: 'operation',
  };
  const operation = OperationRecordHelper.create(new Recorder(book), def, input);
  const foreign = OperationRecordHelper.create(new Recorder(book), { ...def, contextId: randomUUID(), executionId: other.id }, input);
  book.add(new BaseRecord({ material: 'reference' }));
  assert.equal(ExecutionRecordHelper.get(book, execution.id), execution);
  assert.equal(OperationRecordHelper.get(book, operation.id), operation);
  assert.deepEqual(OperationRecordHelper.findByExecution(new Recorder(book), execution.id), [operation]);
  assert.deepEqual(OperationRecordHelper.findByExecution(new Recorder(book), other.id), [foreign]);
  assert.throws(() => OperationRecordHelper.get(book, execution.id), /Operation does not exist/);
  assert.throws(() => ExecutionRecordHelper.get(book, operation.id), /Execution does not exist/);
  assert.throws(() => OperationRecordHelper.findByExecution(new Recorder(book), 'missing'), /Execution does not exist/);
  const result = { nested: ['result'] };
  OperationRecordHelper.complete(new Recorder(book), operation.id, result);
  ExecutionRecordHelper.complete(new Recorder(book), execution.id, result);
  result.nested.push('changed');
  assert.deepEqual(readOutput(operation.value), { nested: ['result'] });
  assert.deepEqual(readOutput(execution.value), { nested: ['result'] });
  const error = { code: 'TEST', message: 'failed', detail: { retry: false } };
  OperationRecordHelper.fail(new Recorder(book), foreign.id, error);
  ExecutionRecordHelper.fail(new Recorder(book), other.id, error);
  error.detail.retry = true;
  assert.equal(foreign.value.error.detail.retry, false);
  assert.equal(other.value.error.detail.retry, false);
});

test('BaseRecord is the base; execution and operation relations live outside their value', () => {
  const value = { nested: { items: ['a'] } };
  const base = new BaseRecord(value);
  assert.equal(base.value, value); // Base shape does not impose a content policy.
  const runtime = createRecordedRuntime(),
    book = runtime.recorder.book,
    execution = ExecutionRecordHelper.create(new Recorder(book), new Clock(), randomUUID(), { input: value, settings }, runtime.record.id);
  const operation = OperationRecordHelper.create(
    new Recorder(book),
    {
      contextId: randomUUID(),
      executionId: execution.id,
      operationInstanceId: 'n',
      operation: 'echo',
      label: 'echo',
      source: 'test',
      caller: 'execution',
      callee: 'operation',
    },
    value,
  );
  assert.ok(execution instanceof BaseRecord && execution instanceof ExecutionRecord);
  assert.ok(operation instanceof BaseRecord && operation instanceof OperationRecord);
  assert.notEqual(operation.id, execution.id);
  assert.equal(operation.executionId, execution.id);
  assert.equal(operation.value.executionId, undefined);
  assert.equal(book.get(operation.id), operation);
  value.nested.items.push('changed');
  assert.deepEqual(operation.value.input.nested.items, ['a']);
  assert.deepEqual(execution.value.input.nested.items, ['a']);
  assert.throws(() => operation.value.input.nested.items.push('x'), TypeError);
  assert.throws(() => {
    operation.executionId = 'other';
  }, TypeError);
  assert.equal(book.call, undefined); // Book has no work-execution entry point.
  assert.throws(() => ExecutionRecordHelper.create(new Recorder(book), new Clock(), randomUUID(), { input: new Map(), settings }, runtime.record.id), /plain/);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => ExecutionRecordHelper.create(new Recorder(book), new Clock(), randomUUID(), { input: cycle, settings }, runtime.record.id), /cyclic/);
});

test('construction does not execute; repeated calls share the callable identity, not the invocation identity', async () => {
  const runtime = createRecordedRuntime();
  const book = runtime.recorder.book;
  const node = new TestOperation(runtime, echo);
  assert.equal(node.getRecords, undefined);
  assert.equal(node.exeId, undefined);
  const execution = begin(runtime);
  assert.equal(OperationRecordHelper.findByExecution(new Recorder(book), recordFor(execution).id).length, 0);
  const value = { x: 1 };
  assert.equal(await node.call(callFor(execution), value), value);
  assert.equal(await node.call(callFor(execution), value), value);
  const calls = OperationRecordHelper.findByExecution(new Recorder(book), recordFor(execution).id);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.ok(calls.every((op) => op.operationInstanceId === node.id && op.executionId === recordFor(execution).id));
  const secondNode = new TestOperation(runtime, echo);
  assert.notEqual(secondNode.id, node.id);
  const past = ExecutionRecordHelper.observe(runtime.recording, callFor(execution));
  complete(execution, value);
  value.x = 9;
  assert.equal(readOutput(ExecutionRecordHelper.observe(runtime.recording, callFor(execution)).execution.value).x, 1);
  assert.equal(readOutput(past.execution.value), undefined);
  await assert.rejects(node.call(callFor(execution), value), /ended/);
});

test('one node overlaps calls within and across executions without mixing input or record ownership', async () => {
  const runtime = createRecordedRuntime(),
    book = runtime.recorder.book,
    a = begin(runtime),
    b = begin(runtime);
  const pending = new Map();
  let ready;
  const allStarted = new Promise((resolve) => {
    ready = resolve;
  });
  const node = new TestOperation(runtime, {
    load: identity,
    transform: (value) =>
      new Promise((resolve) => {
        pending.set(value, resolve);
        if (pending.size === 3) ready();
      }),
    accept: (result, context) => ({ result, original: runtime.getOperationContext(context).input }),
  });
  const first = node.call(callFor(a), 'a1'),
    second = node.call(callFor(b), 'b'),
    third = node.call(callFor(a), 'a2');
  await allStarted;
  pending.get('b')('B');
  assert.deepEqual(await second, { result: 'B', original: 'b' });
  complete(b, 'B');
  pending.get('a2')('A2');
  await third;
  pending.get('a1')('A1');
  assert.deepEqual(await first, { result: 'A1', original: 'a1' });
  complete(a, 'A');
  for (const execution of [a, b]) {
    const facts = ExecutionRecordHelper.observe(runtime.recording, callFor(execution));
    validateSnapshot(facts);
    assert.ok(facts.operations.every((op) => op.executionId === recordFor(execution).id && op.operationInstanceId === node.id));
  }
  assert.deepEqual(
    OperationRecordHelper.findByExecution(new Recorder(book), recordFor(a).id)

      .map((op) => readOutput(op.value).original),
    ['a1', 'a2'],
  );
  assert.equal(OperationRecordHelper.findByExecution(new Recorder(book), recordFor(b).id).length, 1);
});

test('Paired operations reject foreign parents, duplicate endings and ending before children', () => {
  const runtime = createRecordedRuntime(),
    book = runtime.recorder.book,
    a = ExecutionRecordHelper.create(new Recorder(book), new Clock(), randomUUID(), { input, settings }, runtime.record.id),
    b = ExecutionRecordHelper.create(new Recorder(book), new Clock(), randomUUID(), { input, settings }, runtime.record.id);
  const def = {
    contextId: randomUUID(),
    executionId: a.id,
    operationInstanceId: 'n',
    operation: 'x',
    label: 'x',
    source: 'test',
    caller: 'execution',
    callee: 'operation',
  };
  const parent = OperationRecordHelper.create(new Recorder(book), def, {});
  assert.throws(() => OperationRecordHelper.create(new Recorder(book), { ...def, executionId: b.id, parentOperationId: parent.id }, {}), /another execution/);
  const child = OperationRecordHelper.create(new Recorder(book), { ...def, contextId: randomUUID(), parentOperationId: parent.id }, {});
  assert.throws(() => OperationRecordHelper.complete(new Recorder(book), parent.id, {}), /active operations/);
  assert.throws(() => ExecutionRecordHelper.complete(new Recorder(book), a.id, {}), /active operations/);
  OperationRecordHelper.complete(new Recorder(book), child.id, {});
  OperationRecordHelper.complete(new Recorder(book), parent.id, {});
  assert.throws(() => OperationRecordHelper.complete(new Recorder(book), parent.id, {}), /ended/);
  assert.throws(() => OperationRecordHelper.complete(new Recorder(book), a.id, {}), /Operation does not exist/);
  ExecutionRecordHelper.complete(new Recorder(book), a.id, {});
  assert.throws(() => ExecutionRecordHelper.complete(new Recorder(book), a.id, {}), /ended/);
  assert.equal(a.status, 'succeeded');
  assert.equal(parent.status, 'succeeded');
  assert.equal(child.status, 'succeeded');
});

test('Observer execution observes execution, operations and boundaries from the same records', async () => {
  const facts = await execute();
  validateSnapshot(facts);
  assert.deepEqual(Object.keys(facts).sort(), ['attempts', 'events', 'execution', 'operations']);
  assert.equal(facts.operations.length, 3);
  assert.equal(facts.attempts.length, 11);
  const sequence = projectExecution(facts).callSequence;
  assert.deepEqual(
    sequence.participants.map((p) => p.id),
    ['caller', 'execution', 'operation', 'attempt'],
  );
  assert.equal(sequence.calls.length, 1 + facts.operations.length + facts.attempts.length);
  assert.equal(sequence.events, facts.events);
  for (const attempt of facts.attempts) {
    const call = sequence.calls.find((c) => c.id === attempt.id);
    assert.equal(call.caller, 'operation');
    assert.equal(call.callee, 'attempt');
    assert.equal(call.parentId, attempt.operationId);
    assert.equal(call.target, attempt.callee);
  }
  const expectedActions = {
    selection: ['prepareModelRequest', 'invokeModel', 'acceptModelOutput'],
    answer: ['assembleContext', 'prepareModelRequest', 'invokeModel', 'acceptModelOutput'],
    memory: ['prepareModelRequest', 'invokeModel', 'acceptModelOutput', 'applyMemory'],
  };
  for (const operation of facts.operations) {
    const attempts = facts.attempts.filter((attempt) => attempt.operationId === operation.id);
    assert.deepEqual(
      attempts.map((attempt) => attempt.name),
      expectedActions[operation.operation],
    );
    const preparation = attempts.find((attempt) => attempt.name === 'prepareModelRequest');
    const invocation = attempts.find((attempt) => attempt.name === 'invokeModel');
    const acceptance = attempts.find((attempt) => attempt.name === 'acceptModelOutput');
    assert.deepEqual(invocation.value.input, readOutput(preparation.value));
    assert.deepEqual(acceptance.value.input, readOutput(invocation.value));
    assert.deepEqual(readOutput(operation.value), readOutput(attempts.at(-1).value));
    if (operation.operation === 'memory') assert.deepEqual(attempts.at(-1).value.input, readOutput(acceptance.value));
  }
  const select = facts.operations.find((op) => op.operation === 'selection');
  const answer = facts.operations.find((op) => op.operation === 'answer');
  const assembled = facts.attempts.find((attempt) => attempt.operationId === answer.id && attempt.name === 'assembleContext');
  assert.deepEqual(assembled.value.input, readOutput(select.value));
  assert.deepEqual(answer.value.input, { selection: readOutput(select.value), memories: [] });
  assert.deepEqual(readOutput(facts.execution.value), readOutput(answer.value));
  for (const op of facts.operations) {
    assert.equal(op.executionId, facts.execution.id);
    assert.equal(op.status, 'succeeded');
    assert.equal('durationMs' in op, false);
    assert.equal('outputId' in op, false);
  }
  const view = projectExecution(facts);
  assert.equal(view.callSequence.calls.filter((call) => call.recordType === 'operation').length, 3);
  assert.equal(view.callSequence.calls.filter((call) => call.recordType === 'attempt').length, 11);
  assert.deepEqual(view.result, { kind: 'answer', content: '海盐项目' });
});

test('Acceptance failure preserves raw output, records no accepted result, and propagates the original error', async () => {
  const facts = await execute('broken-json');
  const answer = facts.operations.find((op) => op.operation === 'answer');
  const invoked = facts.attempts.find((attempt) => attempt.operationId === answer.id && attempt.name === 'invokeModel');
  const accepted = facts.attempts.find((attempt) => attempt.operationId === answer.id && attempt.name === 'acceptModelOutput');
  assert.equal(readOutput(invoked.value).content, 'broken-json');
  assert.equal(accepted.value.input.content, 'broken-json');
  assert.equal(readOutput(accepted.value), undefined);
  assert.equal(readOutput(answer.value), undefined);
  assert.equal(facts.execution.value.error.code, 'INVALID_JSON');
  assert.equal(projectExecution(facts).error.code, 'INVALID_JSON');
  const runtime = createRecordedRuntime(),
    execution = begin(runtime),
    failure = new RuntimeError('TEST', 'test');
  const node = new TestOperation(runtime, {
    ...echo,
    transform() {
      throw failure;
    },
  });
  await assert.rejects(node.call(callFor(execution), input), (error) => error === failure);
  assert.equal(
    ExecutionRecordHelper.observe(runtime.recording, callFor(execution)).attempts.some((attempt) => attempt.name === 'accept'),
    false,
  );
});

test('missing or contradictory facts are rejected instead of repaired by the projection', async () => {
  const facts = await execute();
  for (const corrupt of [
    (f) => {
      delete f.execution.contextId;
    },
    (f) => {
      delete f.operations[0].contextId;
    },
    (f) => {
      delete f.attempts[0].contextId;
    },
    (f) => {
      f.operations[0].contextId = f.execution.contextId;
    },
    (f) => {
      f.attempts[0].contextId = f.operations[0].id;
    },
    (f) => {
      f.operations[0].executionId = f.execution.contextId;
    },
    (f) => {
      delete f.execution.status;
    },
    (f) => {
      f.execution.status = 'running';
    },
    (f) => {
      f.operations[0].status = 'failed';
    },
    (f) => {
      delete f.operations[0].status;
    },
    (f) => f.operations.pop(),
    (f) => f.attempts.pop(),
    (f) => {
      f.attempts[0].operationId = f.execution.id;
    },
    (f) => {
      f.attempts[0].operationId = f.operations[1].id;
    },
    (f) => {
      f.attempts[0].id = f.operations[0].id;
    },
    (f) => {
      f.attempts[0].status = 'failed';
    },
    (f) => {
      f.attempts[0].name = '';
    },
    (f) => {
      f.attempts[0].label = 123;
    },
    (f) => {
      const operationEnd = f.events.find((event) => event.callId === f.operations[0].id && event.value.type === 'return');
      const attemptEnd = f.events.find((event) => event.callId === f.attempts[2].id && event.value.type === 'return');
      [operationEnd.callId, attemptEnd.callId] = [attemptEnd.callId, operationEnd.callId];
    },
    (f) => {
      f.operations[0].executionId = 'missing';
    },
    (f) => {
      f.operations[0].parentOperationId = 'missing';
    },
    (f) => {
      f.operations[0].value.error = { code: 'x', message: 'x' };
    },
    (f) => f.events.pop(),
    (f) => {
      f.events[1].sequence = 99;
    },
    (f) => {
      f.operations[0].id = f.execution.id;
    },
    (f) => {
      f.events[0].offsetMs = -1;
    },
  ]) {
    const invalid = structuredClone(facts);
    corrupt(invalid);
    assert.throws(() => projectExecution(invalid));
  }
});

test('publication failure does not change execution facts or operation output', async (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const runtime = createRecordedRuntime(() => {
    throw new Error('viewer unavailable');
  });
  const execution = begin(runtime);
  const node = new TestOperation(runtime, echo);
  assert.equal(await node.call(callFor(execution), input), input);
  complete(execution, input);
  assert.equal(projectExecution(ExecutionRecordHelper.observe(runtime.recording, callFor(execution))).status, 'succeeded');
  const snapshot = ExecutionRecordHelper.observe(runtime.recording, callFor(execution));
  const processes = [snapshot.execution, ...snapshot.operations, ...snapshot.attempts].reduce((count, record) => count + record.value.processes.length, 0);
  assert.equal(log.mock.callCount(), snapshot.events.length + processes);
});

test('Paired operations use the record tree without scanning Book', (t) => {
  const book = new RecordBook();
  const root = RuntimeRecordHelper.create(new Recorder(book));
  const execution = ExecutionRecordHelper.create(new Recorder(book), new Clock(), randomUUID(), { input, settings }, root.id);
  const record = OperationRecordHelper.create(
    new Recorder(book),
    {
      contextId: randomUUID(),
      executionId: execution.id,
      operationInstanceId: 'n',
      operation: 'x',
      label: 'x',
      source: 'test',
      caller: 'execution',
      callee: 'processing',
    },
    input,
  );
  t.mock.method(book, 'values', () => {
    throw new Error('Unexpected full scan');
  });
  assert.deepEqual(OperationRecordHelper.findByExecution(new Recorder(book), execution.id), [record]);
  assert.throws(() => ExecutionRecordHelper.complete(new Recorder(book), execution.id, {}), /active operations/);
  assert.equal(execution.status, 'running');
  assert.equal(Object.hasOwn(execution.value, 'output'), false);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => OperationRecordHelper.complete(new Recorder(book), record.id, cycle), /cyclic/);
  assert.equal(record.status, 'running');
  assert.equal(Object.hasOwn(record.value, 'output'), false);
  OperationRecordHelper.complete(new Recorder(book), record.id, {});
  ExecutionRecordHelper.complete(new Recorder(book), execution.id, {});
  assert.equal(record.status, 'succeeded');
  assert.equal(execution.status, 'succeeded');
  assert.throws(() => {
    record.status = 'running';
  }, TypeError);
  assert.throws(() => OperationRecordHelper.fail(new Recorder(book), record.id, { code: 'x', message: 'x' }), /ended/);
});
