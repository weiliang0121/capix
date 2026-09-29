import { ExecutionRecordHelper } from '@capix-observer/runtime';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, Runtime, Execution, Operation, Attempt, RecordBook, RuntimeRecorder, TranscriptRecord, MemoryRecord, observeMemory } from '@capix-observer/runtime';
import { initializeObserver, ObserverExecution, observeExecution, observeOverview, acceptExecutionInput } from '@capix-observer/service';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 1000 };
const createRecorder = (book = new RecordBook()) => new RuntimeRecorder(book);
const proposed = (content = '北京', memoryId = null) => ({ action: memoryId ? 'update' : 'create', memoryId, change: '确认地点', sourceIndexes: [0], result: { topic: '地点', content, sourceIndexes: [0] } });
const raw = (value) => ({ id: 'fixture', model: 'fixture', finishReason: 'stop', usage: null, content: JSON.stringify(value) });

class Echo extends Execution {
  execute(context) {
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
      async execute(context) {
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

test('Runtime reserves before input acceptance across different E instances and always releases after failure', async () => {
  const runtime = new Runtime();
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  class Wait extends Execution {
    async execute() {
      await pending;
      return 'done';
    }
  }
  const first = new Wait(runtime.executionInvocations).call('first', { settings });
  let accepted = false;
  await assert.rejects(
    new Echo(runtime.executionInvocations).submit(
      () => {
        accepted = true;
        runtime.transcript.append({ role: 'user', content: 'must not append' });
        return 'next';
      },
      { settings },
    ),
    (error) => error.code === 'RUNTIME_BUSY',
  );
  assert.equal(accepted, false);
  assert.equal(runtime.transcript.length, 0);
  release();
  await first;
  await assert.rejects(
    new Echo(runtime.executionInvocations).submit(
      () => {
        throw new Error('invalid input');
      },
      { settings },
    ),
    /invalid input/,
  );
  assert.equal(runtime.running, false);
  assert.equal(await new Echo(runtime.executionInvocations).call('next', { settings }), 'next');
});

test('Transcript validates full batches, records changes once, and keeps old evidence stable across segmentation', () => {
  const recorder = createRecorder();
  const runtime = new Runtime({ recorder });
  const transcript = runtime.transcript;
  transcript.append({ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' });
  const before = transcript.snapshot();
  assert.throws(() => transcript.append({ role: 'user', content: 'valid' }, { role: 'user', content: ' ' }));
  transcript.startSegment(1);
  assert.throws(() => transcript.startSegment(1));
  const records = [...recorder.book.values()];
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record instanceof TranscriptRecord && record.transcriptId === transcript.id));
  assert.deepEqual(records[1].value, { action: 'segment', previousStart: 0, start: 1, end: 2 });
  assert.equal(records[0].value.messages.length, 2);
  transcript.append({ role: 'user', content: 'three' });
  assert.equal(before.length, 2);
  assert.equal(records[0].value.messages.length, 2);
  assert.equal(records[0].executionId, undefined);
});

test('Memories owns official mutation, records standalone changes, skips unchanged content and exposes no write bypass', () => {
  const recorder = createRecorder();
  const runtime = new Runtime({ recorder, messages: [{ role: 'user', content: '北京' }] });
  const [memory] = runtime.memories.apply([proposed()]);
  const original = memory.snapshot();
  const changes = () => [...recorder.book.values()].filter((r) => r instanceof MemoryRecord);
  assert.equal(changes().length, 1);
  assert.equal(changes()[0].operationId, undefined);
  assert.deepEqual(runtime.memories.apply([proposed('北京', memory.id)]), []);
  assert.equal(changes().length, 1);
  assert.throws(() => runtime.memories.apply([proposed('上海', memory.id), proposed('广州', 'missing')]));
  assert.equal(memory.content, '北京');
  runtime.memories.apply([proposed('上海', memory.id)]);
  assert.equal(runtime.memories.get(memory.id), memory);
  assert.equal(original.content, '北京');
  assert.equal(changes().length, 2);
  assert.equal(typeof memory.update, 'undefined');
  assert.equal(typeof runtime.memories.add, 'undefined');
  assert.throws(() => memory.sourceIndexes.push(1));
  assert.equal(observeMemory(runtime.memories, recorder.book).items[0].records.length, 2);
});

test('content registration failure preserves the applied fact and does not pretend to roll it back', () => {
  class Reject extends RecordBook {
    add(record) {
      if (record instanceof TranscriptRecord) throw new Error('cannot record message');
      return super.add(record);
    }
  }
  const runtime = new Runtime({ recorder: createRecorder(new Reject()) });
  assert.throws(
    () => runtime.transcript.append({ role: 'user', content: 'accepted' }),
    (error) => error.code === 'RECORDING_FAILED',
  );
  assert.equal(runtime.transcript.current('user').content, 'accepted');
});

test('replacing execution behaviors retains messages, memories, counts and the complete observed history', async () => {
  const provider = {
    async invoke(request, purpose) {
      const input = JSON.parse(request.messages[1].content);
      if (purpose === 'selection') return raw({ historyIndexes: input.history.map((item) => item.index) });
      if (purpose === 'answer') return raw({ kind: 'answer', content: '已了解' });
      return raw({ memories: input.memories.length ? [] : [proposed()] });
    },
  };
  const environment = initializeObserver(provider);
  const run = async (execution, text) => observeExecution(execution, environment.recording, () => acceptExecutionInput(environment.transcript, { messages: [{ role: 'user', content: text }] }), { settings });
  const first = await run(environment.execution, '我在北京');
  const memory = environment.runtime.memories.values()[0];
  environment.execution = new ObserverExecution(environment.runtime, provider);
  const second = await run(environment.execution, '继续');
  assert.equal(second.execution.status, 'succeeded');
  assert.equal(environment.runtime.memories.get(memory.id), memory);
  assert.equal(environment.runtime.selectionUsage.get(environment.transcript.get(0)), 1);
  assert.equal(second.operations[0].value.input.memories[0].id, memory.id);
  const observation = observeOverview(environment);
  assert.equal(observation.executions.length, 2);
  assert.ok(observation.executions.every((execution) => execution.response?.content === '已了解'));
  assert.equal(observation.messages[0].count, 1);
  const change = [...environment.book.values()].find((r) => r instanceof MemoryRecord);
  const apply = first.attempts.find((r) => r.name === 'applyMemory');
  assert.equal(change.callId, apply.id);
  assert.equal(change.contextId, apply.contextId);
  const response = [...environment.book.values()].find((r) => r instanceof TranscriptRecord && r.value.action === 'append' && r.value.messages[0].role === 'assistant');
  assert.equal(response.callId, first.execution.id);
});

test('EOA rejects cross-Runtime contexts independently of the recording layer', async () => {
  const a = new Runtime();
  const b = new Runtime();
  class Leaf extends Attempt {
    name = 'leaf';
    label = 'leaf';
    source = 'test';
    callee = 'processing';
    execute() {
      assert.fail('foreign leaf must not run');
    }
  }
  class Work extends Operation {
    name = 'work';
    label = 'work';
    source = 'test';
    async execute(context) {
      await assert.rejects(new Leaf(b.attemptInvocations).call(context, 'input'), /another Runtime/);
      return 'done';
    }
  }
  class Root extends Execution {
    async execute(context) {
      await assert.rejects(new Work(b.operationInvocations).call(context, 'input'), /another Runtime/);
      return new Work(a.operationInvocations).call(context, 'input');
    }
  }
  assert.equal(await new Root(a.executionInvocations).call('input', { settings }), 'done');
});

test('Invocation distinguishes successful work from failed result registration without retrying', async (t) => {
  const recorder = createRecorder();
  t.mock.method(ExecutionRecordHelper, 'complete', () => {
    throw new Error('cannot register result');
  });
  const runtime = new Runtime({ recorder });
  let count = 0;
  let context;
  class NonRecordable extends Execution {
    execute(current) {
      context = current;
      count++;
      return 'completed';
    }
  }
  await assert.rejects(new NonRecordable(runtime.executionInvocations).call('input', { settings }), (error) => error.code === 'RECORDING_FAILED');
  assert.equal(context.status, 'succeeded');
  assert.equal(count, 1);
  assert.equal(runtime.running, false);
});

test('Invocation start registration failure prevents work and releases the Runtime', async (t) => {
  const recorder = createRecorder();
  t.mock.method(ExecutionRecordHelper, 'create', () => {
    throw new Error('cannot begin record');
  });
  const runtime = new Runtime({ recorder });
  let context;
  let executions = 0;
  class Work extends Execution {
    execute() {
      executions++;
    }
  }
  await assert.rejects(
    new Work(runtime.executionInvocations).call('input', { settings }, (current) => {
      context = current;
    }),
    (error) => error.code === 'RECORDING_FAILED',
  );
  assert.equal(executions, 0);
  assert.equal(context.status, 'failed');
  assert.equal(runtime.running, false);
});

test('Invocation preserves both work and failure-registration errors without replacing the context error', async (t) => {
  const recorder = createRecorder();
  const failure = new Error('work failed');
  const registration = new Error('cannot register failure');
  t.mock.method(ExecutionRecordHelper, 'fail', () => {
    throw registration;
  });
  const runtime = new Runtime({ recorder });
  let context;
  class Work extends Execution {
    execute(current) {
      context = current;
      throw failure;
    }
  }
  await assert.rejects(new Work(runtime.executionInvocations).call('input', { settings }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, failure);
    assert.equal(error.errors[0], failure);
    assert.equal(error.errors[1].cause, registration);
    return true;
  });
  assert.equal(context.state.error, failure);
  assert.equal(runtime.running, false);
});

test('memory registration failure preserves the applied batch prefix and does not silently apply the rest', () => {
  class Reject extends RecordBook {
    add(record) {
      if (record instanceof MemoryRecord) throw new Error('cannot record memory');
      return super.add(record);
    }
  }
  const runtime = new Runtime({ recorder: createRecorder(new Reject()), messages: [{ role: 'user', content: '地点' }] });
  assert.throws(
    () => runtime.memories.apply([proposed('北京'), proposed('上海')]),
    (error) => error.code === 'RECORDING_FAILED',
  );
  assert.deepEqual(
    runtime.memories.values().map((memory) => memory.content),
    ['北京'],
  );
});
