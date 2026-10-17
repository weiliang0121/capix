import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExceptionContract, MemoryCheckpointStore, assembleRuntime } from '@capix/server-runtime';

const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
const output = { result: (value) => value, delta: (value) => value };

function restore(definition, { round = 1, currentInput = { stage: 'saved' } } = {}) {
  const store = new MemoryCheckpointStore();
  const events = [];
  const contextId = `restored-round-${round}`;
  store.save({ id: 'saved-image', formatVersion: 2, contract: { key: definition.checkpoint.key, version: 1 }, point: 'saved', frame: { owner: { contextId, level: 'runtime' }, round, phase: 'execute', input: { stage: 'original' }, currentInput, nextChildOrder: 0, children: [], ...(round === 2 ? { continuation: { fromRound: 1, stage: 'accept', reason: 'saved continuation' } } : {}) }, state: { source: 'durable' }, references: {} }, 0);
  const runtime = assembleRuntime(definition, {
    providers: [],
    checkpoints: { store },
    source: {
      entry: () => null,
      capture: () => null,
      output: () => ({
        receive(event) {
          events.push(event);
        },
      }),
    },
  });
  return { runtime, store, events, contextId };
}

for (const continuation of ['accept', 'exception']) {
  test(`restored execute continues through ${continuation} into one normal round with a new output segment and the original Context identity`, async () => {
    const rejected = new ExceptionContract(`test.restored-output.${continuation}`);
    const writers = [];
    const execution = [];
    const nextInput = { stage: 'next' };
    const final = { answer: 'final result' };
    const definition = {
      level: 'runtime',
      children: [],
      maxRounds: 2,
      raises: [rejected],
      output,
      run: {
        requires: {},
        execute(work) {
          execution.push({ kind: 'normal', id: undefined, round: work.round });
          assert.equal(work.round, 2);
          assert.deepEqual(work.initialInput, { stage: 'original' });
          assert.equal(work.input, nextInput);
          assert.throws(() => writers[0].emit('stale preview'), { code: 'OUTPUT_CLOSED' });
          writers.push(work.output);
          work.output.emit('new preview');
          work.checkpoint.save(definition.checkpoint.points[0], { source: 'second round' }, {});
          return final;
        },
        accept(work) {
          assert.throws(() => writers.at(-1).emit('after execute'), { code: 'OUTPUT_CLOSED' });
          return work.round === 1 ? work.continue(nextInput, 'advance after restored work') : work.delivered;
        },
      },
      exceptions: {
        requires: {},
        accepts: [rejected],
        handle(work) {
          assert.equal(continuation, 'exception');
          assert.equal(work.round, 1);
          assert.throws(() => writers[0].emit('after rejection'), { code: 'OUTPUT_CLOSED' });
          return work.continue(nextInput, 'advance after restored rejection');
        },
      },
      checkpoint: {
        key: `test.restored-output.${continuation}`,
        version: 1,
        input: codec,
        output: codec,
        points: [
          {
            name: 'saved',
            references: {},
            state: codec,
            resume: {
              requires: {},
              execute(work, state) {
                execution.push({ kind: 'restored', id: undefined, round: work.round });
                assert.deepEqual(work.initialInput, { stage: 'original' });
                assert.deepEqual(work.input, { stage: 'saved' });
                assert.deepEqual(state, { source: 'durable' });
                writers.push(work.output);
                work.output.emit('restored preview');
                if (continuation === 'exception') throw rejected.create('restore needs correction', {});
                return { answer: 'restored result' };
              },
            },
          },
        ],
      },
    };
    const { runtime, store, events, contextId } = restore(definition);
    assert.equal(await runtime.resume(contextId, {}), final);
    assert.deepEqual(execution, [
      { kind: 'restored', id: undefined, round: 1 },
      { kind: 'normal', id: undefined, round: 2 },
    ]);
    assert.notEqual(writers[0], writers[1]);
    assert.throws(() => writers[1].emit('after completion'), { code: 'OUTPUT_CLOSED' });
    assert.deepEqual(
      events.map((event) => [event.round, event.sequence, event.kind]),
      [
        [1, 1, 'started'],
        [1, 2, 'delta'],
        [1, 3, 'sealed'],
        [1, 4, 'discarded'],
        [2, 1, 'started'],
        [2, 2, 'delta'],
        [2, 3, 'sealed'],
        [2, 4, 'completed'],
      ],
    );
    assert.ok(events.every((event) => event.contextId === contextId));
    assert.equal(events[3].reason, continuation === 'exception' ? 'exception' : 'continue');
    assert.equal(events.at(-1).result, final);
    const head = store.read(contextId);
    assert.equal(head.image.frame.round, 2);
    assert.deepEqual(head.image.frame.input, { stage: 'original' });
    assert.deepEqual(head.image.frame.currentInput, nextInput);
    assert.deepEqual(head.delivery, { status: 'succeeded', output: final, progress: { round: 2, currentInput: nextInput, phase: 'receive' } });
  });
}

test('restoring an existing second round preserves its round and current input without invoking normal execute', async () => {
  let resumes = 0;
  const currentInput = { stage: 'saved second round' };
  const definition = {
    level: 'runtime',
    children: [],
    maxRounds: 2,
    raises: [],
    output,
    run: { requires: {}, execute: () => assert.fail('normal work must not replay') },
    checkpoint: {
      key: 'test.restored-output.second-round',
      version: 1,
      input: codec,
      output: codec,
      points: [
        {
          name: 'saved',
          references: {},
          state: codec,
          resume: {
            requires: {},
            execute(work) {
              resumes++;
              assert.equal(work.round, 2);
              assert.deepEqual(work.initialInput, { stage: 'original' });
              assert.deepEqual(work.input, currentInput);
              work.output.emit('second round preview');
              return 'resumed final';
            },
          },
        },
      ],
    },
  };
  const { runtime, store, events, contextId } = restore(definition, { round: 2, currentInput });
  assert.equal(await runtime.resume(contextId, {}), 'resumed final');
  assert.equal(resumes, 1);
  assert.ok(events.every((event) => event.contextId === contextId && event.round === 2));
  assert.deepEqual(
    events.map((event) => event.kind),
    ['started', 'delta', 'sealed', 'completed'],
  );
  assert.deepEqual(store.read(contextId).delivery.progress, { round: 2, currentInput, phase: 'receive' });
});
