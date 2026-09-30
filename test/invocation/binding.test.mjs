import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Invocation, InvocationContext, Recorder, RecordBook, ExecutionRecord, ExecutionRecordHelper, InvocationBoundaryRecordHelper, TranscriptRecord, MemoryRecord, createRuntime } from '@capix-observer/runtime';

const operation = { id: 'work', name: 'work', label: 'Work', source: 'test' };
const attempt = { name: 'apply', label: 'Apply', source: 'test', callee: 'processing' };
const identity = { maxRounds: 1, execute: (context) => context.currentInput };

test('live nested calls and content sources use their bound records without Context lookup', async (t) => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createRuntime({ recorder, messages: [{ role: 'user', content: 'Beijing' }] });
  let outer;
  let nested;
  let leaf;
  const root = runtime.executionInvocations.create('root', {
    context: { settings: {} },
    work: {
      maxRounds: 1,
      async execute(context, invocation) {
        assert.equal(invocation.context, context);
        outer = runtime.operationInvocations.create(invocation, {
          input: 'outer',
          description: operation,
          work: {
            maxRounds: 1,
            async execute(context, invocation) {
              nested = runtime.operationInvocations.create(invocation, {
                input: 'nested',
                description: operation,
                work: {
                  maxRounds: 1,
                  async execute(context, invocation) {
                    leaf = runtime.attemptInvocations.create(invocation, {
                      input: 'leaf',
                      description: attempt,
                      work: {
                        maxRounds: 1,
                        execute(context, invocation) {
                          assert.equal(invocation.context, context);
                          runtime.context.memories.apply([{ action: 'create', memoryId: null, change: 'location', sourceIndexes: [0], result: { topic: 'location', content: 'Beijing', sourceIndexes: [0] } }], invocation.source);
                          return 'done';
                        },
                        receive(context, result, invocation) {
                          assert.equal(invocation, leaf);
                          assert.equal(invocation.context, context);
                          return result.output;
                        },
                      },
                    });
                    return leaf.run();
                  },
                },
              });
              return nested.run();
            },
          },
        });
        const output = await outer.run();
        runtime.context.transcript.appendFrom([{ role: 'assistant', content: output }], invocation.source);
        return output;
      },
    },
  });
  assert.equal(root.record, undefined);
  assert.equal(await root.run(), 'done');
  assert.equal(outer.record.parentId, root.record.id);
  assert.equal(nested.record.parentId, outer.record.id);
  assert.equal(leaf.record.parentId, nested.record.id);
  for (const invocation of [root, outer, nested, leaf]) {
    assert.equal(invocation.record.contextId, invocation.context.id);
    assert.equal(invocation.record, recorder.book.get(invocation.record.id));
    assert.equal(invocation.record.status, 'succeeded');
    assert.equal(invocation.context.record, undefined);
    assert.equal(invocation.context.invocation, undefined);
  }
  const memory = [...recorder.book.values()].find((record) => record instanceof MemoryRecord);
  const answer = [...recorder.book.values()].find((record) => record instanceof TranscriptRecord && record.parentId);
  assert.equal(memory.parentId, leaf.record.id);
  assert.equal(memory.operationId, nested.record.id);
  assert.equal(answer.parentId, root.record.id);
  assert.equal(ExecutionRecordHelper.snapshot(recorder, root.record.id).events.length, 8);
});

test('one reused work behavior keeps separate bindings during overlapping child calls', async () => {
  const runtime = createRuntime({ recorder: new Recorder(new RecordBook()) });
  const pending = new Map();
  const work = { maxRounds: 1, execute: (context, invocation) => new Promise((resolve) => pending.set(context.input, { invocation, resolve })) };
  const root = runtime.executionInvocations.create('root', {
    context: { settings: {} },
    work: {
      maxRounds: 1,
      async execute(context, invocation) {
        const first = runtime.operationInvocations.create(invocation, { input: 'first', description: operation, work: work });
        const second = runtime.operationInvocations.create(invocation, { input: 'second', description: operation, work: work });
        const firstResult = first.run();
        const secondResult = second.run();
        assert.equal(pending.get('first').invocation, first);
        assert.equal(pending.get('second').invocation, second);
        assert.notEqual(first.record, second.record);
        pending.get('second').resolve('second result');
        assert.equal(await secondResult, 'second result');
        assert.equal(first.record.status, 'running');
        pending.get('first').resolve('first result');
        assert.equal(await firstResult, 'first result');
        return 'done';
      },
    },
  });
  assert.equal(await root.run(), 'done');
});

test('binding rejects a foreign Context, duplicate binding and missing binding before executing work', async () => {
  for (const mode of ['foreign', 'duplicate', 'missing']) {
    const context = new InvocationContext('input');
    const first = new ExecutionRecord(context.id, { input: 'input', settings: {}, startedAt: new Date().toISOString() }, 'runtime-record');
    const invocation = new Invocation({
      context,
      signal: new AbortController().signal,
      work: { maxRounds: 1, execute: () => assert.fail('invalid binding must prevent work') },
      recording: {
        begin(context, bind) {
          if (mode === 'missing') return;
          if (mode === 'foreign') bind(new ExecutionRecord('other-context', first.value, 'runtime-record'));
          else {
            bind(first);
            bind(first);
          }
        },
      },
    });
    const expected = mode === 'foreign' ? /another Context/ : mode === 'duplicate' ? /already bound/ : /not bound/;
    await assert.rejects(invocation.run(), (error) => error.code === 'RECORDING_FAILED' && expected.test(error.cause.message));
    assert.equal(invocation.record, mode === 'duplicate' ? first : undefined);
    assert.equal(context.status, 'failed');
  }
});

test('a recorded child cannot start before its parent has registered its call', async () => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createRuntime({ recorder });
  const root = runtime.executionInvocations.create('root', { context: { settings: {} }, work: identity });
  const child = runtime.operationInvocations.create(root, { input: 'child', description: operation, work: identity });
  await assert.rejects(child.run(), /Parent invocation record is not registered here/);
  assert.equal(root.record, undefined);
  assert.equal(child.record, undefined);
  assert.deepEqual([...recorder.book.values()], [runtime.record]);
  assert.equal(root.context.status, 'running');
});

test('binding survives a subsequent call-event registration failure without pretending the record disappeared', async (t) => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createRuntime({ recorder });
  t.mock.method(InvocationBoundaryRecordHelper, 'create', () => {
    throw new Error('event registration failed');
  });
  const invocation = runtime.executionInvocations.create('input', { context: { settings: {} }, work: { maxRounds: 1, execute: () => assert.fail('must not execute') } });
  await assert.rejects(invocation.run(), /event registration failed/);
  assert.equal(invocation.context.status, 'failed');
  assert.equal(invocation.record, recorder.book.get(invocation.record.id));
  assert.equal(invocation.record.contextId, invocation.context.id);
});

test('without recording, the invocation still provides the live parent and no record source', async () => {
  const runtime = createRuntime();
  const root = runtime.executionInvocations.create('root', {
    context: { settings: {} },
    work: {
      maxRounds: 1,
      execute(context, invocation) {
        assert.equal(invocation.source, undefined);
        const child = runtime.operationInvocations.create(invocation, { input: new Map([['value', 1]]), description: operation, work: identity });
        assert.equal(child.record, undefined);
        assert.equal(child.source, undefined);
        return child.run();
      },
    },
  });
  assert.equal((await root.run()).get('value'), 1);
});
