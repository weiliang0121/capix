import { lifecycleFor } from '../fixtures/lifecycle.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Execution, Operation, Attempt, Runtime, RuntimeRecorder, RecordBook, RecordIndex, InvocationRecord } from '@capix-observer/runtime';

import { hasOutput, readOutput, validateSnapshot } from '@capix-observer/protocol';

import { projectExecution } from '../../apps/observer/.test-dist/observation/project.js';

function fixture() {
  const recorder = new RuntimeRecorder(new RecordBook(), new RecordIndex((r) => r.executionId), new RecordIndex((r) => r.operationId), new RecordIndex((r) => r.executionId));
  return { recorder, runtime: new Runtime({ recorder: recorder }) };
}
class LocalOperation extends Operation {
  name = 'local';
  label = 'local';
  source = 'test';
  execute(context) {
    return context.currentInput;
  }
}
const entry = (sequence, stage, type, body, round = 1) => ({ sequence, round, stage, type, occurredAt: '2026-09-25T00:00:00.000Z', offsetMs: sequence, ...body });
const captured = () => {
  const record = new InvocationRecord({ input: null, processes: [] });
  record.append(entry(1, 'execute', 'start', { input: null }));
  record.append(entry(2, 'execute', 'return', { output: { content: 'original' } }));
  return record;
};

test('default E/O/A results keep one local output snapshot and survive JSON observation', async () => {
  const { runtime, recorder } = fixture();
  const payload = { content: 'record payload '.repeat(1000) };
  class Work extends Attempt {
    name = 'work';
    label = 'work';
    source = 'test';
    callee = 'processing';
    execute() {
      return payload;
    }
  }
  class Processing extends LocalOperation {
    work = new Work(runtime);
    execute(context) {
      return this.work.call(context, null);
    }
  }
  class Main extends Execution {
    operation = new Processing(runtime);
    execute(context) {
      return this.operation.call(context, null);
    }
  }
  let context;
  const publications = [];
  recorder.subscribe((snapshot) => {
    validateSnapshot(snapshot);
    publications.push(snapshot);
  });
  assert.equal(
    await new Main(runtime).call(null, { settings: {} }, (c) => {
      context = c;
    }),
    payload,
  );
  const snapshot = recorder.snapshot(context);
  const records = [snapshot.execution, ...snapshot.operations, ...snapshot.attempts];
  assert.equal(records.length, 3);
  assert.equal(snapshot.events.length, 6);
  for (const { value } of records) {
    assert.equal(value.resultOf, 2);
    assert.equal(Object.hasOwn(value, 'output'), false);
    assert.equal(value.processes[2].resultOf, 2);
    assert.equal(Object.hasOwn(value.processes[2], 'output'), false);
    assert.equal(readOutput(value), value.processes[1].output);
    assert.equal(Object.isFrozen(readOutput(value)), true);
  }
  const pending = publications.find((s) => s.attempts[0]?.value.processes.length === 2);
  assert.equal(hasOutput(pending.attempts[0].value), false);
  assert.equal(pending.attempts[0].value.processes.length, 2);
  const serialized = JSON.stringify(snapshot);
  const restored = JSON.parse(serialized);
  validateSnapshot(restored);
  assert.deepEqual(projectExecution(restored).result, payload);
  assert.ok(projectExecution(restored).nodes.every((n) => n.output.content === payload.content));
  payload.content = 'later mutation';
  assert.notEqual(readOutput(snapshot.execution.value).content, payload.content);
  const expanded = JSON.parse(serialized);
  for (const { value } of [expanded.execution, ...expanded.operations, ...expanded.attempts]) {
    const output = readOutput(value);
    value.processes[2].output = output;
    delete value.processes[2].resultOf;
    value.output = output;
    delete value.resultOf;
  }
  assert.ok(Buffer.byteLength(serialized) < Buffer.byteLength(JSON.stringify(expanded)) * 0.5);
});

test('custom receivers preserve a distinct snapshot even when mutating and returning the same object', async () => {
  for (const mutate of [false, true]) {
    const { runtime, recorder } = fixture();
    const lifecycle = lifecycleFor(runtime).execution({ input: null, settings: {} });
    const context = lifecycle.begin();
    class Custom extends LocalOperation {
      receive(_context, result) {
        if (mutate) result.output.content = 'changed';
        return result.output;
      }
    }
    const input = { content: 'original' };
    const result = await new Custom(runtime).call(context, input);
    lifecycle.succeed(context, result);
    const snapshot = recorder.snapshot(context);
    validateSnapshot(snapshot);
    const value = snapshot.operations[0].value;
    assert.equal(value.processes[1].output.content, 'original');
    assert.equal(value.processes[2].output.content, mutate ? 'changed' : 'original');
    assert.notEqual(value.processes[1].output, value.processes[2].output);
    assert.equal(value.resultOf, 3);
    assert.equal(readOutput(value), value.processes[2].output);
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
  const result = await new LocalOperation(runtime).call(context, 'value');
  lifecycle.succeed(context, result);
  const snapshot = JSON.parse(JSON.stringify(recorder.snapshot(context)));
  for (const corrupt of [
    (v) => {
      v.resultOf = 1;
    },
    (v) => {
      v.output = 'duplicate';
    },
    (v) => {
      v.processes[2].resultOf = 3;
    },
    (v) => {
      v.processes[2].round = 2;
    },
    (v) => {
      v.processes[2].output = 'duplicate';
    },
  ]) {
    const changed = structuredClone(snapshot);
    corrupt(changed.operations[0].value);
    assert.throws(() => validateSnapshot(changed));
  }
});
