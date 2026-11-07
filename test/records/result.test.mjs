import { ExecutionFixture, OperationFixture, AttemptFixture } from '../fixtures/behavior.mjs';
import { callFor, rememberCall } from '../fixtures/lifecycle.mjs';
import { subscribeExecutions } from '@capix/observer-service';
import { ExecutionRecordHelper } from '@capix/records';
import { lifecycleFor } from '../fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runner, Resources, Scene, Node, bindRecording } from '@capix/server-runtime';
import { Recorder, RecordBook, InvocationRecord, CallableRecord } from '@capix/records';
import { createBoundRuntime, observeCall } from '../fixtures/runtime.mjs';

import { hasOutput, readOutput, validateExecutionRecordSnapshot } from '@capix/protocol';

import { projectExecution } from '../../apps/observer/.test-dist/observation/project.js';

function fixture() {
  const recorder = new Recorder(new RecordBook());
  return { recorder, runtime: createBoundRuntime({ recorder }) };
}
class LocalOperation extends OperationFixture {
  name = 'local';
  label = 'local';
  source = 'test';
  execute(context, invocation) {
    rememberCall(invocation);
    return context.currentInput;
  }
}
const entry = (sequence, stage, type, body, round = 1) => ({ sequence, eventSequence: sequence, round, stage, type, occurredAt: '2026-09-25T00:00:00.000Z', offsetMs: sequence, ...body });
const captured = () => {
  const record = new InvocationRecord({ input: null, processes: [], relationChanges: [] });
  record.append(entry(1, 'execute', 'start', { input: null }));
  record.append(entry(2, 'execute', 'return', { output: { content: 'original' } }));
  return record;
};

test('default E/O/A results keep one local output snapshot and survive JSON observation', async () => {
  const { runtime, recorder } = fixture();
  const payload = { content: 'record payload '.repeat(1000) };
  class Work extends AttemptFixture {
    name = 'work';
    label = 'work';
    source = 'test';
    execute() {
      return payload;
    }
  }
  class Processing extends LocalOperation {
    action = new Work(runtime.attemptInvocationBuilder);
    execute(context, invocation) {
      rememberCall(invocation);
      return this.action.call(invocation, null);
    }
  }
  class Main extends ExecutionFixture {
    operation = new Processing(runtime.operationInvocationBuilder);
    execute(context, invocation) {
      rememberCall(invocation);
      return this.operation.call(invocation, null);
    }
  }
  let context;
  const publications = [];
  subscribeExecutions(runtime.recording, (snapshot) => {
    validateExecutionRecordSnapshot(snapshot);
    publications.push(snapshot);
  });
  assert.deepEqual(
    await new Main(runtime.executionInvocationBuilder).call(null, { settings: {} }, (c) => {
      context = c;
    }),
    payload,
  );
  const snapshot = observeCall(runtime.recording, callFor(context));
  const records = [snapshot.execution, ...snapshot.operations, ...snapshot.attempts];
  assert.equal(records.length, 3);
  assert.equal(snapshot.events.length, 6);
  for (const { value } of records) {
    assert.equal(value.resultOf, 2);
    assert.equal(Object.hasOwn(value, 'output'), false);
    assert.equal(value.processes.length, 2);
    assert.equal(readOutput(value), value.processes[1].output);
    assert.equal(Object.isFrozen(readOutput(value)), true);
  }
  const pending = publications.flatMap((s) => s.calls).find((call) => call.structureKind === 'node' && call.value.processes.length === 2);
  assert.equal(hasOutput(pending.value), false);
  assert.equal(pending.value.processes.length, 2);
  const serialized = JSON.stringify(snapshot);
  const restored = JSON.parse(serialized);
  validateExecutionRecordSnapshot(restored);
  assert.deepEqual(projectExecution(restored).result, payload);
  assert.ok(projectExecution(restored).nodes.every((n) => n.output.content === payload.content));
  payload.content = 'later mutation';
  assert.notEqual(readOutput(snapshot.execution.value).content, payload.content);
  const expanded = JSON.parse(serialized);
  for (const { value } of [expanded.execution, ...expanded.operations, ...expanded.attempts]) {
    const output = readOutput(value);
    value.output = output;
    delete value.resultOf;
  }
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.attempts[0].value)) < Buffer.byteLength(JSON.stringify(expanded.attempts[0].value)) * 0.6);
});

test('parent reception keeps the child returned snapshot separate from the transformed result', async () => {
  for (const mutate of [false, true]) {
    const recorder = new Recorder(new RecordBook());
    const child = new Node({ run: (work) => work.input });
    const scene = new Scene().add({ child });
    scene.run = (work) =>
      work.children.child.invoke(work.input, {
        result: {
          succeeded(value) {
            assert.ok(Object.isFrozen(value));
            return mutate ? { ...value, content: 'changed' } : value;
          },
        },
      });
    const input = { content: 'original' };
    const result = await new Runner(scene, new Resources(), undefined, { observations: [bindRecording(recorder)] }).build().run(input);
    assert.deepEqual(result, { content: mutate ? 'changed' : 'original' });
    assert.equal(input.content, 'original');
    const records = [...recorder.book.values()].filter((record) => record instanceof CallableRecord);
    const childRecord = records.find((record) => record.structureKind === 'node');
    const parentRecord = records.find((record) => record.structureKind === 'scene');
    assert.equal(readOutput(childRecord.value).content, 'original');
    assert.equal(readOutput(parentRecord.value).content, mutate ? 'changed' : 'original');
    assert.notEqual(readOutput(childRecord.value), readOutput(parentRecord.value));
    assert.equal(childRecord.value.resultOf, 2);
  }
});

test('local output references reject missing, forward, chained and cross-round targets without appending', () => {
  for (const target of [0, -1, 1, 3, 4, 1.5, NaN]) {
    const record = captured();
    assert.throws(() => record.append(entry(3, 'receive', 'return', { resultOf: target })));
    assert.equal(record.value.processes.length, 2);
  }
  const record = captured();
  assert.throws(() => record.append(entry(3, 'receive', 'return', { resultOf: 2, output: 'ambiguous' })));
  assert.throws(() => record.append(entry(3, 'receive', 'return', { resultOf: 2 }, 2)));
  record.append(entry(3, 'receive', 'return', { resultOf: 2 }));
  assert.throws(() => record.append(entry(4, 'receive', 'return', { resultOf: 3 })));
  record.complete(null, 2);
  assert.equal(readOutput(record.value).content, 'original');
});

test('the final result adopts only the last accepted round and retains earlier results', () => {
  const record = captured();
  record.append(entry(3, 'receive', 'continue', { input: 'next', reason: 'refine' }));
  record.append(entry(4, 'execute', 'start', { input: 'next' }, 2));
  record.append(entry(5, 'execute', 'return', { output: 'next output' }, 2));
  record.append(entry(6, 'receive', 'return', { output: 'accepted output' }, 2));
  for (const resultOf of [2, 5, 7]) assert.throws(() => record.complete(null, resultOf));
  assert.equal(record.status, 'running');
  record.complete(null, 6);
  assert.equal(readOutput(record.value), 'accepted output');
  assert.equal(record.value.processes[1].output.content, 'original');
});

test('observation rejects corrupted compact references rather than silently losing output', async () => {
  const { runtime, recorder } = fixture();
  const lifecycle = lifecycleFor(runtime).execution({ input: null, settings: {} });
  const context = lifecycle.begin();
  const result = await new LocalOperation(runtime.operationInvocationBuilder).call(callFor(context), 'value');
  lifecycle.succeed(context, result);
  const snapshot = JSON.parse(JSON.stringify(observeCall(runtime.recording, callFor(context))));
  for (const corrupt of [
    (v) => {
      v.resultOf = 1;
    },
    (v) => {
      v.output = 'duplicate';
    },
    (v) => {
      v.processes[1].resultOf = 3;
    },
    (v) => {
      v.processes[1].resultOf = 1;
    },
    (v) => {
      v.processes[1].resultOf = 2;
    },
  ]) {
    const changed = structuredClone(snapshot);
    corrupt(changed.calls.find((call) => call.id !== changed.execution.id).value);
    assert.throws(() => validateExecutionRecordSnapshot(changed));
  }
});
