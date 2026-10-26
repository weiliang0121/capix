import { ResourceBindings } from '../fixtures/resources.mjs';
import { createEnvironment } from '../fixtures/environment.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindRecording, bindInvocationObservation, invocationRecording } from '@capix/server-runtime';
import { Recorder, RecordBook, ExecutionRecordHelper, InvocationBoundaryRecordHelper, TranscriptRecord, MemoryRecord } from '@capix/records';

import { createBoundRuntime, observeCall } from '../fixtures/runtime.mjs';

const operation = { id: 'work', name: 'work', label: 'Work', source: 'test' };
const attempt = { name: 'apply', label: 'Apply', source: 'test', callee: 'processing' };
const identity = { maxRounds: 1, execute: (context) => context.currentInput };

test('live nested calls and content sources use their bound records without Context lookup', async (t) => {
  const recorder = new Recorder(new RecordBook());
  const { runtime, transcript, memories } = createEnvironment({ recorder, messages: [{ role: 'user', content: 'Beijing' }] });
  let outer;
  let nested;
  let leaf;
  const root = runtime.executionInvocationBuilder.create('root', {
    context: { settings: {} },
    work: {
      maxRounds: 1,
      async execute(context, invocation) {
        assert.equal(invocation.context, context);
        outer = runtime.operationInvocationBuilder.create(invocation, {
          input: 'outer',
          description: operation,
          work: {
            maxRounds: 1,
            async execute(context, invocation) {
              nested = runtime.operationInvocationBuilder.create(invocation, {
                input: 'nested',
                description: operation,
                work: {
                  maxRounds: 1,
                  async execute(context, invocation) {
                    leaf = runtime.attemptInvocationBuilder.create(invocation, {
                      input: 'leaf',
                      description: attempt,
                      work: {
                        maxRounds: 1,
                        execute(context, invocation) {
                          assert.equal(invocation.context, context);
                          memories.apply([{ action: 'create', memoryId: null, change: 'location', sourceIndexes: [0], result: { topic: 'location', content: 'Beijing', sourceIndexes: [0] } }], { origin: invocation.origin, observation: invocation.observation.memory });
                          return 'done';
                        },
                        accept(context, output, invocation) {
                          assert.equal(invocation, leaf);
                          assert.equal(invocation.context, context);
                          return output;
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
        transcript.appendFrom([{ role: 'assistant', content: output }], { origin: invocation.origin, observation: invocation.observation.transcript });
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
  assert.equal(memory.contextId, leaf.context.id);
  assert.equal(answer.parentId, root.record.id);
  assert.equal(observeCall(runtime.recording, root).events.length, 8);
});

test('one reused work behavior keeps separate bindings during overlapping child calls', async () => {
  const runtime = createBoundRuntime({ recorder: new Recorder(new RecordBook()) });
  const pending = new Map();
  const work = { maxRounds: 1, execute: (context, invocation) => new Promise((resolve) => pending.set(context.input, { invocation, resolve })) };
  const root = runtime.executionInvocationBuilder.create('root', {
    context: { settings: {} },
    work: {
      maxRounds: 1,
      async execute(context, invocation) {
        const first = runtime.operationInvocationBuilder.create(invocation, { input: 'first', description: operation, work: work });
        const second = runtime.operationInvocationBuilder.create(invocation, { input: 'second', description: operation, work: work });
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

test('the recording preset rejects foreign facts, repeated starts and an unstarted recording parent', () => {
  for (const mode of ['foreign', 'duplicate', 'missing-parent']) {
    const recorder = new Recorder(new RecordBook());
    const installation = bindRecording(recorder);
    const declarations = [invocationRecording({}, { failure: 'propagate' })];
    const resources = new ResourceBindings({});
    const parent = installation.bindInvocation({ identity: { kind: 'scene', contextId: 'parent' }, description: { id: 'runtime' }, resources, declarations });
    const scope = mode === 'missing-parent' ? installation.bindInvocation({ identity: { kind: 'group', contextId: 'child', parentContextId: 'parent' }, resources, declarations }, parent) : parent;
    const observation = bindInvocationObservation({ ...scope.setup, resources: scope.resources }, []);
    const fact = { kind: 'started', input: null, identity: scope.setup.identity, eventSequence: 1, occurredAt: new Date().toISOString(), monotonicTime: 0 };
    if (mode === 'duplicate') assert.equal(observation.publish(fact), undefined);
    const expected = mode === 'foreign' ? /another local observation/ : mode === 'duplicate' ? /only start once/ : /has not started/;
    const failure = observation.publish(mode === 'foreign' ? { ...fact, identity: { ...fact.identity, contextId: 'foreign' } } : fact);
    assert.equal(failure.code, 'OBSERVATION_FAILED');
    assert.match(failure.cause.message, expected);
    assert.equal(scope.available(), false);
    assert.equal(Boolean(scope.record), mode === 'duplicate');
    if (scope.record) assert.equal(recorder.book.get(scope.record.id), scope.record);
  }
});

test('a recorded child cannot start before its parent has registered its call', async () => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createBoundRuntime({ recorder });
  const root = runtime.executionInvocationBuilder.create('root', { context: { settings: {} }, work: identity });
  const child = runtime.operationInvocationBuilder.create(root, { input: 'child', description: operation, work: identity });
  await assert.rejects(child.run(), (error) => error.code === 'OBSERVATION_FAILED' && /has not started/.test(error.cause.message));
  assert.equal(root.record, undefined);
  assert.equal(child.record, undefined);
  assert.equal([...recorder.book.values()].filter((record) => record.kind === 'execution' || record.structureKind === 'group').length, 0);
  assert.equal(root.context.status, 'running');
});

test('binding survives a subsequent call-event registration failure without pretending the record disappeared', async (t) => {
  const recorder = new Recorder(new RecordBook());
  const runtime = createBoundRuntime({ recorder });
  const invocation = runtime.executionInvocationBuilder.create('input', { context: { settings: {} }, work: { maxRounds: 1, execute: () => assert.fail('must not execute') } });
  const create = InvocationBoundaryRecordHelper.create;
  t.mock.method(InvocationBoundaryRecordHelper, 'create', (...args) => {
    if (args[1].callId === invocation.record?.id) throw new Error('event registration failed');
    return create(...args);
  });
  await assert.rejects(invocation.run(), (error) => error.code === 'OBSERVATION_FAILED' && error.cause.message === 'event registration failed');
  assert.equal(invocation.context.status, 'failed');
  assert.equal(invocation.record, recorder.book.get(invocation.record.id));
  assert.equal(invocation.record.contextId, invocation.context.id);
});

test('without recording, the invocation still provides the live parent and no record source', async () => {
  const runtime = createBoundRuntime();
  const root = runtime.executionInvocationBuilder.create('root', {
    context: { settings: {} },
    work: {
      maxRounds: 1,
      execute(context, invocation) {
        assert.equal(invocation.source, undefined);
        const child = runtime.operationInvocationBuilder.create(invocation, { input: new Map([['value', 1]]), description: operation, work: identity });
        assert.equal(child.record, undefined);
        assert.equal(child.source, undefined);
        return child.run();
      },
    },
  });
  assert.equal((await root.run()).get('value'), 1);
});
