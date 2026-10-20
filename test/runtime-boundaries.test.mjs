import { ModelInteractions, ModelSource } from '@capix/observer-service';
import { createEnvironment } from './fixtures/environment.mjs';
import { ExecutionFixture, OperationFixture, AttemptFixture } from './fixtures/behavior.mjs';
import { callFor, rememberCall } from './fixtures/lifecycle.mjs';
import { InvocationRecordHelper } from '@capix/server-runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, RecordBook, Recorder, TranscriptRecord, MemoryRecord, observeMemory } from '@capix/server-runtime';
import { Driver, defineNode } from '@capix/server-runtime';
import { createBoundRuntime } from './fixtures/runtime.mjs';
import { initializeObserver, bindConversation, ConversationSceneDefinition, observeExecution, observeOverview, acceptConversationInput } from '@capix/observer-service';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const createRecorder = (book = new RecordBook()) => new Recorder(book);
const proposed = (content = '北京', memoryId = null) => ({ action: memoryId ? 'update' : 'create', memoryId, change: '确认地点', sourceIndexes: [0], result: { topic: '地点', content, sourceIndexes: [0] } });
const raw = (value) => ({ id: 'fixture', model: 'fixture', finishReason: 'stop', usage: null, content: JSON.stringify(value) });

class Echo extends ExecutionFixture {
  execute(context, invocation) {
    rememberCall(invocation);
    return context.currentInput;
  }
}

test('Invocation consumes an established context and rejects concurrent reuse', async () => {
  let executions = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const invocation = new Invocation({
    context: new InvocationContext('input'),
    work: {
      maxRounds: 1,
      async execute(context, invocation) {
        rememberCall(invocation);
        executions++;
        await pending;
        return context.currentInput;
      },
    },
    signal: new AbortController().signal,
  });
  assert.equal(invocation.context.input, 'input');
  assert.equal(invocation.context.progress.round, 0);
  const result = invocation.run();
  await assert.rejects(invocation.run(), /already started/);
  release();
  assert.equal(await result, 'input');
  assert.equal(invocation.context.status, 'succeeded');
  assert.equal(executions, 1);
  await assert.rejects(invocation.run(), /already started/);
});

test('Driver blocks concurrent entry before source validation and releases after failure', async () => {
  const { transcript } = createEnvironment();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const driver = new Driver();
  const bound = driver.bind(defineNode()({ run: { execute: (work) => (work.input === 'wait' ? pending : work.input) } }), {
    providers: [],
    source: {
      capture: (input) => {
        if (input === 'invalid') throw new Error('invalid input');
        if (input === 'append') {
          accepted = true;
          transcript.append({ role: 'user', content: 'must not append' });
        }
        return null;
      },
    },
  });
  let accepted = false;
  const first = driver.run(bound, 'wait', {});
  await assert.rejects(driver.run(bound, 'append', {}), (error) => error.code === 'RUNTIME_BUSY');
  assert.equal(accepted, false);
  assert.equal(transcript.length, 0);
  release();
  await first;
  await assert.rejects(driver.run(bound, 'invalid', {}), /invalid input/);
  assert.equal(driver.isRunning(bound), false);
  assert.equal(await driver.run(bound, 'next', {}), 'next');
});

test('Transcript validates full batches, records changes once, and keeps old evidence stable across segmentation', () => {
  const recorder = createRecorder();
  const { transcript } = createEnvironment({ recorder });
  transcript.append({ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' });
  const before = transcript.snapshot();
  assert.throws(() => transcript.append({ role: 'user', content: 'valid' }, { role: 'user', content: ' ' }));
  transcript.startSegment(1);
  assert.throws(() => transcript.startSegment(1));
  const records = [...recorder.book.values()].filter((record) => record instanceof TranscriptRecord);
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record instanceof TranscriptRecord && record.transcriptId === transcript.id));
  assert.deepEqual(records[1].value, { action: 'segment', previousStart: 0, start: 1, end: 2 });
  assert.equal(records[0].value.end - records[0].value.start, 2);
  transcript.append({ role: 'user', content: 'three' });
  assert.equal(before.length, 2);
  assert.equal(records[0].value.end - records[0].value.start, 2);
  assert.equal(records[0].executionId, undefined);
});

test('Memories owns official mutation, records standalone changes, skips unchanged content and exposes no write bypass', () => {
  const recorder = createRecorder();
  const { memories } = createEnvironment({ recorder, messages: [{ role: 'user', content: '北京' }] });
  const [memory] = memories.apply([proposed()]);
  const original = memory.snapshot();
  const changes = () => [...recorder.book.values()].filter((r) => r instanceof MemoryRecord);
  assert.equal(changes().length, 1);
  assert.equal(changes()[0].parentId, undefined);
  assert.deepEqual(memories.apply([proposed('北京', memory.id)]), []);
  assert.equal(changes().length, 1);
  assert.throws(() => memories.apply([proposed('上海', memory.id), proposed('广州', 'missing')]));
  assert.equal(memory.content, '北京');
  memories.apply([proposed('上海', memory.id)]);
  assert.equal(memories.get(memory.id), memory);
  assert.equal(original.content, '北京');
  assert.equal(changes().length, 2);
  assert.equal(typeof memory.update, 'undefined');
  assert.equal(typeof memories.add, 'undefined');
  assert.throws(() => memory.sourceIndexes.push(1));
  assert.equal(observeMemory(memories, recorder.book).items[0].records.length, 2);
});

test('content registration failure preserves the applied fact and does not pretend to roll it back', () => {
  class Reject extends RecordBook {
    add(record) {
      if (record instanceof TranscriptRecord) throw new Error('cannot record message');
      return super.add(record);
    }
  }
  const { transcript } = createEnvironment({ recorder: createRecorder(new Reject()) });
  assert.throws(
    () => transcript.append({ role: 'user', content: 'accepted' }),
    (error) => error.code === 'OBSERVATION_FAILED',
  );
  assert.equal(transcript.current('user').content, 'accepted');
});

test('separate drivers and bindings share entities without absorbing their lifetimes', async () => {
  const provider = {
    async invoke(request, purpose) {
      const input = JSON.parse(request.messages[1].content);
      if (purpose === 'selection') return raw({ historyIndexes: input.history.map((item) => item.index) });
      if (purpose === 'answer') return raw({ kind: 'answer', content: '已了解' });
      return raw({ memories: input.memories.length ? [] : [proposed()] });
    },
  };
  const environment = initializeObserver(provider);
  const run = async (driver, scene, text) => observeExecution(driver, scene, environment.recording, { messages: [{ role: 'user', content: text }] }, { settings });
  const first = await run(environment.driver, environment.scene, '我在北京');
  const memory = environment.memories.values()[0];
  const driver = new Driver({ observations: [environment.recording], changes: environment.changes });
  const next = bindConversation(driver, new ConversationSceneDefinition(), { transcript: environment.transcript, memories: environment.memories, selectionUsage: environment.selectionUsage, active: environment.content.active }, new ModelInteractions(new ModelSource(provider)));
  const second = await run(driver, next, '继续');
  assert.equal(second.execution.status, 'succeeded');
  assert.equal(environment.memories.get(memory.id), memory);
  assert.equal(environment.selectionUsage.get(environment.transcript.get(0)), 1);
  assert.equal(second.calls.filter((item) => item.structureKind === 'group' && item.id !== second.execution.id).find((operation) => operation.name === 'memory').value.input.memories[0].id, memory.id);
  const observation = observeOverview(environment);
  assert.equal(observation.executions.length, 2);
  assert.equal(environment.transcript.current('assistant').content, '已了解');
  assert.equal(observation.messages[0].count, 1);
  const change = [...environment.book.values()].find((r) => r instanceof MemoryRecord);
  const apply = first.calls.filter((item) => item.structureKind === 'node').find((r) => r.name === 'applyMemory');
  assert.equal(change.callId, apply.id);
  assert.equal(change.contextId, apply.contextId);
  const response = [...environment.book.values()].find((r) => r instanceof TranscriptRecord && r.value.action === 'append' && environment.transcript.get(r.value.start)?.role === 'assistant');
  assert.equal(response.callId, first.execution.id);
});

test('EOA rejects cross-BoundRuntime contexts independently of the recording layer', async () => {
  const a = createBoundRuntime();
  const b = createBoundRuntime();
  class Leaf extends AttemptFixture {
    name = 'leaf';
    label = 'leaf';
    source = 'test';
    callee = 'processing';
    execute() {
      assert.fail('foreign leaf must not run');
    }
  }
  class Work extends OperationFixture {
    name = 'work';
    label = 'work';
    source = 'test';
    async execute(context, invocation) {
      rememberCall(invocation);
      await assert.rejects(new Leaf(b.attemptInvocationBuilder).call(invocation, 'input'), /another binding installation/);
      return 'done';
    }
  }
  class Root extends ExecutionFixture {
    async execute(context, invocation) {
      rememberCall(invocation);
      await assert.rejects(new Work(b.operationInvocationBuilder).call(invocation, 'input'), /another binding installation/);
      return new Work(a.operationInvocationBuilder).call(invocation, 'input');
    }
  }
  assert.equal(await new Root(a.executionInvocationBuilder).call('input', { settings }), 'done');
});

test('Invocation distinguishes successful work from failed result registration without retrying', async (t) => {
  const recorder = createRecorder();
  const finish = InvocationRecordHelper.finish;
  t.mock.method(InvocationRecordHelper, 'finish', (...args) => {
    if (args[1].role === 'conversation-task') throw new Error('cannot register result');
    return finish(...args);
  });
  const runtime = createBoundRuntime({ recorder });
  let count = 0;
  let context;
  class NonRecordable extends ExecutionFixture {
    execute(current) {
      context = current;
      count++;
      return 'completed';
    }
  }
  await assert.rejects(new NonRecordable(runtime.executionInvocationBuilder).call('input', { settings }), (error) => error.code === 'OBSERVATION_FAILED');
  assert.equal(context.status, 'succeeded');
  assert.equal(count, 1);
  assert.equal(runtime.running, false);
});

test('Invocation start registration failure prevents work and releases the BoundRuntime', async (t) => {
  const recorder = createRecorder();
  const add = recorder.add.bind(recorder);
  t.mock.method(recorder, 'add', (record) => {
    if (record.role === 'conversation-task') throw new Error('cannot begin record');
    return add(record);
  });
  const runtime = createBoundRuntime({ recorder });
  let context;
  let executions = 0;
  class Work extends ExecutionFixture {
    execute() {
      executions++;
    }
  }
  await assert.rejects(
    new Work(runtime.executionInvocationBuilder).call('input', { settings }, (current) => {
      context = current;
    }),
    (error) => error.code === 'OBSERVATION_FAILED',
  );
  assert.equal(executions, 0);
  assert.equal(context.status, 'failed');
  assert.equal(runtime.running, false);
});

test('Invocation preserves both work and failure-registration errors without replacing the context error', async (t) => {
  const recorder = createRecorder();
  const failure = new Error('work failed');
  const registration = new Error('cannot register failure');
  const finish = InvocationRecordHelper.finish;
  t.mock.method(InvocationRecordHelper, 'finish', (...args) => {
    if (args[1].role === 'conversation-task') throw registration;
    return finish(...args);
  });
  const runtime = createBoundRuntime({ recorder });
  let context;
  class Work extends ExecutionFixture {
    execute(current) {
      context = current;
      throw failure;
    }
  }
  await assert.rejects(new Work(runtime.executionInvocationBuilder).call('input', { settings }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, failure);
    assert.equal(error.errors[0], failure);
    assert.equal(error.errors[1].cause, registration);
    return true;
  });
  assert.equal(context.state.error, failure);
  assert.equal(runtime.running, false);
});

test('memory registration failure preserves the committed batch and does not hide its remaining changes', () => {
  const failure = new Error('cannot record memory');
  const attempted = [];
  const captured = [];
  class Reject extends RecordBook {
    add(record) {
      if (record instanceof MemoryRecord) {
        attempted.push(record);
        throw failure;
      }
      return super.add(record);
    }
  }
  const recorder = createRecorder(new Reject());
  const { memories } = createEnvironment({
    recorder,
    messages: [{ role: 'user', content: '地点' }],
    changes: {
      capture(event) {
        if (event.type === 'memory') captured.push(event);
      },
    },
  });
  assert.throws(
    () => memories.apply([proposed('北京'), proposed('上海')]),
    (error) => {
      assert.equal(error.code, 'OBSERVATION_FAILED');
      assert.equal(error.cause.code, 'RECORDING_FAILED');
      assert.equal(error.cause.cause, failure);
      return true;
    },
  );
  assert.equal(memories.sequence, 2);
  assert.deepEqual(
    memories.values().map((memory) => memory.content),
    ['北京', '上海'],
  );
  assert.deepEqual(
    captured.map((event) => [event.sequence, event.change.result.content]),
    [
      [1, '北京'],
      [2, '上海'],
    ],
  );
  assert.deepEqual(
    attempted.map((record) => record.value.result.content),
    ['北京'],
    'the failed optional consumer stays disabled; formal change capture still sees both facts',
  );
  assert.equal([...recorder.book.values()].filter((record) => record instanceof MemoryRecord).length, 0);
});
