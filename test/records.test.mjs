import { createRecordScope } from './fixtures/runtime.mjs';
import { RecordingRootHelper } from '@capix/server-runtime';
import { callFor, recordFor } from './fixtures/lifecycle.mjs';
import { subscribeExecutions } from '@capix/observer-service';
import { lifecycleFor } from './fixtures/lifecycle.mjs';
import { readOutput, validateExecutionRecordSnapshot } from '@capix/protocol';
import { createInput, observeFixture } from './fixtures/observer.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Recorder, BaseRecord, CallableRecord, ExecutionRecord, OperationRecord, RecordBook, ExecutionRecordHelper, OperationRecordHelper, Clock } from '@capix/server-runtime';
import { RuntimeError } from '@capix/contracts';
import { createBoundRuntime, observeCall } from './fixtures/runtime.mjs';
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
  return observeFixture(createInput(input), settings, {
    async invoke(_request, purpose) {
      return output(purpose === 'selection' ? '{"historyIndexes":[0]}' : purpose === 'answer' ? answer : '{"memories":[]}');
    },
  });
}
const createRecordedRuntime = (publish) => {
  const runtime = createBoundRuntime({ recorder: new Recorder(new RecordBook(), { clock: new Clock() }) });
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
const groups = (snapshot) => snapshot.calls.filter((call) => call.id !== snapshot.execution.id && call.structureKind === 'group');
const nodes = (snapshot) => snapshot.calls.filter((call) => call.structureKind === 'node');
const directCalls = (recorder, parent) => recorder.tree.children(parent.id).filter((record) => record instanceof CallableRecord);

test('Book stores any record by identity without creating invocation boundaries', () => {
  const book = new RecordBook();
  const value = { material: 'reference' };
  const record = new BaseRecord(value);
  assert.deepEqual(Object.getOwnPropertyNames(RecordBook.prototype).sort(), ['add', 'constructor', 'exportState', 'get', 'values']);
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
  const root = createRecordScope(new Recorder(book));
  const execution = ExecutionRecordHelper.create(new Recorder(book), { contextId: randomUUID(), parentId: root.id }, { input, settings });
  const other = ExecutionRecordHelper.create(new Recorder(book), { contextId: randomUUID(), parentId: root.id }, { input, settings });
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
    execution = ExecutionRecordHelper.create(new Recorder(book), { contextId: randomUUID(), parentId: createRecordScope(runtime.recorder).id }, { input: value, settings });
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
  assert.throws(() => ExecutionRecordHelper.create(new Recorder(book), { contextId: randomUUID(), parentId: createRecordScope(runtime.recorder).id }, { input: new Map(), settings }), /plain/);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => ExecutionRecordHelper.create(new Recorder(book), { contextId: randomUUID(), parentId: createRecordScope(runtime.recorder).id }, { input: cycle, settings }), /cyclic/);
});

test('construction does not execute; repeated calls share the callable identity, not the invocation identity', async () => {
  const runtime = createRecordedRuntime();
  const book = runtime.recorder.book;
  const node = new TestOperation(runtime, echo);
  assert.equal(node.getRecords, undefined);
  assert.equal(node.exeId, undefined);
  const execution = begin(runtime);
  assert.equal(directCalls(runtime.recorder, recordFor(execution)).length, 0);
  const value = { x: 1 };
  assert.equal(await node.call(callFor(execution), value), value);
  assert.equal(await node.call(callFor(execution), value), value);
  const calls = directCalls(runtime.recorder, recordFor(execution));
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.ok(calls.every((op) => op.structureId === node.id && op.parentId === recordFor(execution).id));
  const secondNode = new TestOperation(runtime, echo);
  assert.notEqual(secondNode.id, node.id);
  const past = observeCall(runtime.recording, callFor(execution));
  complete(execution, value);
  value.x = 9;
  assert.equal(readOutput(observeCall(runtime.recording, callFor(execution)).execution.value).x, 1);
  assert.equal(readOutput(past.execution.value), undefined);
  await assert.rejects(async () => node.call(callFor(execution), value), /ended/);
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
        pending.set(value, (result) => resolve({ result, original: value }));
        if (pending.size === 3) ready();
      }),
    accept: identity,
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
    const facts = observeCall(runtime.recording, callFor(execution));
    validateExecutionRecordSnapshot(facts);
    assert.ok(facts.operations.every((op) => op.parentId === recordFor(execution).id && op.structureId === node.id));
  }
  assert.deepEqual(
    directCalls(runtime.recorder, recordFor(a)).map((op) => readOutput(op.value).original),
    ['a1', 'a2'],
  );
  assert.equal(directCalls(runtime.recorder, recordFor(b)).length, 1);
});

test('Paired operations reject foreign parents, duplicate endings and ending before children', () => {
  const runtime = createRecordedRuntime(),
    book = runtime.recorder.book,
    a = ExecutionRecordHelper.create(new Recorder(book), { contextId: randomUUID(), parentId: createRecordScope(runtime.recorder).id }, { input, settings }),
    b = ExecutionRecordHelper.create(new Recorder(book), { contextId: randomUUID(), parentId: createRecordScope(runtime.recorder).id }, { input, settings });
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
  validateExecutionRecordSnapshot(facts);
  assert.deepEqual(Object.keys(facts).sort(), ['boundaries', 'calls', 'execution', 'memories', 'resources', 'rootCall', 'transcripts']);
  assert.deepEqual(
    groups(facts).map((record) => record.name),
    ['prepareContext', 'conversationDecision', 'answer', 'answerCandidate', 'requestModel', 'conversationDecision', 'memory', 'requestModel'],
  );
  assert.equal(nodes(facts).length, 8);
  const sequence = projectExecution(facts).callSequence;
  assert.deepEqual(
    sequence.participants.map((p) => p.id),
    ['caller', 'scene', 'group', 'node'],
  );
  assert.equal(sequence.calls.length, 1 + groups(facts).length + nodes(facts).length);
  assert.deepEqual(
    sequence.events,
    facts.boundaries.filter((event) => event.callId !== facts.rootCall.id),
  );
  for (const attempt of nodes(facts)) {
    const call = sequence.calls.find((c) => c.id === attempt.id);
    assert.equal(call.caller, 'group');
    assert.equal(call.callee, 'node');
    assert.equal(call.parentId, attempt.parentId);
    assert.equal(call.target, attempt.callee);
  }
  const expectedActions = {
    prepareContext: [],
    answer: ['assembleContext', 'prepareModelRequest'],
    answerCandidate: ['acceptModelOutput'],
    memory: ['prepareModelRequest', 'acceptModelOutput', 'applyMemory'],
    requestModel: ['invokeModel'],
    conversationDecision: [],
  };
  for (const operation of groups(facts)) {
    const attempts = nodes(facts).filter((attempt) => attempt.parentId === operation.id);
    assert.deepEqual(
      attempts.map((attempt) => attempt.name),
      expectedActions[operation.name],
    );
    if (operation.name === 'prepareContext') {
      assert.ok(readOutput(operation.value).material.basis);
      continue;
    }
    if (operation.name === 'conversationDecision') {
      assert.ok(['invoke', 'finish'].includes(readOutput(operation.value).kind));
      assert.ok(facts.execution.value.relationChanges.some((entry) => entry.identity.childContextId === operation.contextId && entry.change.kind === 'accepted'));
      continue;
    }
    if (operation.name === 'requestModel') {
      const invocation = attempts[0];
      assert.deepEqual(invocation.value.input, operation.value.input);
      assert.equal(readOutput(invocation.value).kind, 'received');
      assert.deepEqual(readOutput(invocation.value).output, readOutput(operation.value));
      assert.ok(groups(facts).some((parent) => parent.id === operation.parentId));
      continue;
    }
    if (operation.name === 'answer') {
      const preparation = attempts.find((attempt) => attempt.name === 'prepareModelRequest');
      const candidate = groups(facts).find((child) => child.parentId === operation.id && child.name === 'answerCandidate');
      assert.deepEqual(candidate.value.input, readOutput(preparation.value));
      assert.deepEqual(readOutput(operation.value), readOutput(candidate.value));
      continue;
    }
    const preparation = attempts.find((attempt) => attempt.name === 'prepareModelRequest');
    const invocation = groups(facts).find((child) => child.parentId === operation.id && child.name === 'requestModel');
    const acceptance = attempts.find((attempt) => attempt.name === 'acceptModelOutput');
    assert.deepEqual(invocation.value.input, operation.name === 'answerCandidate' ? operation.value.input : readOutput(preparation.value));
    assert.deepEqual(acceptance.value.input.output, readOutput(invocation.value));
    assert.deepEqual(readOutput(operation.value), readOutput(attempts.at(-1).value));
    if (operation.name === 'memory') assert.deepEqual(attempts.at(-1).value.input, readOutput(acceptance.value));
  }
  const preparation = groups(facts).find((op) => op.name === 'prepareContext');
  const answer = groups(facts).find((op) => op.name === 'answer');
  const assembled = nodes(facts).find((attempt) => attempt.parentId === answer.id && attempt.name === 'assembleContext');
  assert.equal('context' in readOutput(preparation.value), false);
  assert.deepEqual(readOutput(preparation.value).material.messageIndexes, [0, 1]);
  assert.deepEqual(readOutput(preparation.value).selection, { historyIndexes: [0] });
  assert.deepEqual(assembled.value.input, { message: { role: 'user', content: input.content }, selectedMessages: [{ index: 0, message: input.history[0] }] });
  assert.deepEqual(answer.value.input, { context: assembled.value.input, memories: [] });
  assert.deepEqual(readOutput(facts.execution.value), readOutput(answer.value));
  for (const op of groups(facts)) {
    assert.ok(facts.calls.some((parent) => parent.id === op.parentId));
    assert.equal(op.status, 'succeeded');
    assert.equal('durationMs' in op, false);
    assert.equal('outputId' in op, false);
  }
  const view = projectExecution(facts);
  assert.deepEqual(
    view.callSequence.calls.filter((call) => call.recordType === 'group' && call.id !== facts.execution.id).map((call) => call.id),
    groups(facts).map((record) => record.id),
  );
  assert.equal(view.callSequence.calls.filter((call) => call.recordType === 'node').length, 8);
  assert.deepEqual(view.result, { kind: 'answer', content: '海盐项目' });
});

test('Acceptance rejection preserves raw output and its original cause without recording an accepted result', async () => {
  const facts = await execute('broken-json');
  const answer = groups(facts).find((op) => op.name === 'answer');
  const candidates = groups(facts).filter((operation) => operation.parentId === answer.id && operation.name === 'answerCandidate');
  assert.equal(candidates.length, 2);
  const candidate = candidates.at(-1);
  const invoked = groups(facts).find((operation) => operation.parentId === candidate.id && operation.name === 'requestModel');
  const accepted = nodes(facts).find((attempt) => attempt.parentId === candidate.id && attempt.name === 'acceptModelOutput');
  assert.equal(readOutput(invoked.value).content, 'broken-json');
  assert.equal(accepted.value.input.output.content, 'broken-json');
  assert.equal(readOutput(accepted.value), undefined);
  assert.equal(readOutput(answer.value), undefined);
  const rejection = facts.execution.value.error;
  assert.equal(rejection.code, 'MODEL_OUTPUT_REJECTED');
  assert.equal(rejection.cause.code, 'INVALID_JSON');
  assert.deepEqual(rejection.detail, { code: 'INVALID_JSON', output: readOutput(invoked.value) });
  assert.deepEqual(projectExecution(facts).error, rejection);
  assert.equal(facts.execution.value.failure.kind, 'exception');
  assert.equal(accepted.value.error.cause.code, 'INVALID_JSON');
  assert.deepEqual(accepted.value.error.detail, { code: 'INVALID_JSON', output: readOutput(invoked.value) });
  assert.equal(nodes(facts).filter((attempt) => candidates.some((candidate) => candidate.id === attempt.parentId) && attempt.name === 'acceptModelOutput' && attempt.status === 'failed').length, 2);
  const runtime = createRecordedRuntime();
  const execution = begin(runtime);
  const failure = new RuntimeError('TEST', 'test');
  const node = new TestOperation(runtime, {
    ...echo,
    transform() {
      throw failure;
    },
  });
  await assert.rejects(node.call(callFor(execution), input), (error) => error === failure);
  assert.equal(
    observeCall(runtime.recording, callFor(execution)).attempts.some((attempt) => attempt.name === 'accept'),
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
      delete f.calls[1].contextId;
    },
    (f) => {
      f.calls[1].contextId = f.execution.contextId;
    },
    (f) => {
      f.calls[2].contextId = f.calls[1].id;
    },
    (f) => {
      f.calls[1].parentId = 'missing';
    },
    (f) => {
      delete f.execution.status;
    },
    (f) => {
      f.execution.status = 'running';
    },
    (f) => {
      f.calls[1].status = 'failed';
    },
    (f) => {
      delete f.calls[1].status;
    },
    (f) => f.calls.pop(),
    (f) => {
      f.calls[1].id = f.execution.id;
    },
    (f) => {
      f.calls[1].name = '';
    },
    (f) => {
      f.calls[1].label = 123;
    },
    (f) => {
      f.calls[1].structureKind = 'execution';
    },
    (f) => {
      f.calls[1].value.error = { code: 'x', message: 'x' };
    },
    (f) =>
      f.boundaries.splice(
        f.boundaries.findIndex((event) => event.callId === f.calls[1].id && event.value.type === 'return'),
        1,
      ),
    (f) => {
      f.boundaries[1].sequence = 99;
    },
    (f) => {
      f.boundaries[0].offsetMs = -1;
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
  assert.equal(projectExecution(observeCall(runtime.recording, callFor(execution))).status, 'succeeded');
  const snapshot = observeCall(runtime.recording, callFor(execution));
  const processes = [snapshot.execution, ...snapshot.operations, ...snapshot.attempts].reduce((count, record) => count + record.value.processes.length, 0);
  const relations = [snapshot.execution, ...snapshot.operations, ...snapshot.attempts].reduce((count, record) => count + record.value.relationChanges.length, 0);
  assert.ok(log.mock.callCount() >= processes + relations);
});

test('Paired operations use the record tree without scanning Book', (t) => {
  const book = new RecordBook();
  const root = createRecordScope(new Recorder(book));
  const execution = ExecutionRecordHelper.create(new Recorder(book), { contextId: randomUUID(), parentId: root.id }, { input, settings });
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
