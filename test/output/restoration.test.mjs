import { installCallable } from '../fixtures/driver.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Scene, ExceptionContract, MemoryCheckpointStore } from '@capix/server-runtime';

const codec = { encode: (value) => structuredClone(value), decode: (value) => structuredClone(value) };
const output = { result: (value) => value, delta: (value) => value };

function restore(definition, { round = 1, currentInput = { stage: 'saved' } } = {}) {
  const store = new MemoryCheckpointStore(),
    events = [];
  const contextId = `restored-round-${round}`;
  store.save({ id: 'saved-image', formatVersion: 5, contract: { key: definition.checkpoint.key, version: 1 }, point: 'saved', frame: { owner: { contextId, kind: 'scene' }, round, phase: 'execute', input: { stage: 'original' }, currentInput, nextChildOrder: 0, children: [], ...(round === 2 ? { continuation: { fromRound: 1, stage: 'accept', reason: 'saved continuation' } } : {}) }, state: { source: 'durable' }, references: {} }, 0);
  let captures = 0;
  const runtime = installCallable(new Scene(definition), {
    providers: [],
    checkpoints: { store },
    source: {
      capture: () => {
        captures++;
        return null;
      },
      output: () => ({
        receive: (event) => {
          events.push(event);
        },
      }),
    },
  });
  return { runtime, store, events, contextId, captures: () => captures };
}

for (const failed of [false, true]) {
  test(`restored work has its own bounded output section and ${failed ? 'discards a rejected candidate' : 'commits its direct final result'}`, async () => {
    const rejected = new ExceptionContract('test.restored-output').create('invalid restored candidate', {});
    const final = { answer: 'restored result' };
    let writer,
      executions = 0;
    const definition = {
      output,
      deps: {},
      run: () => assert.fail('normal work must not replay'),
      checkpoint: {
        key: 'test.restored-output',
        version: 1,
        input: codec,
        output: codec,
        points: [
          {
            name: 'saved',
            references: {},
            state: codec,
            resume: {
              deps: {},
              run(work, state) {
                executions++;
                assert.equal(work.round, 1);
                assert.deepEqual(work.initialInput, { stage: 'original' });
                assert.deepEqual(work.input, { stage: 'saved' });
                assert.deepEqual(state, { source: 'durable' });
                writer = work.output;
                work.output.emit('restored preview');
                work.checkpoint({ point: definition.checkpoint.points[0], state: { source: 'resumed' }, refs: {} });
                if (failed) throw rejected;
                return final;
              },
            },
          },
        ],
      },
    };
    const { runtime, store, events, contextId } = restore(definition);
    if (failed) await assert.rejects(runtime.resume(contextId, {}), (error) => error === rejected);
    else assert.equal(await runtime.resume(contextId, {}), final);
    assert.equal(executions, 1);
    assert.throws(() => writer.emit('late'), { code: 'OUTPUT_CLOSED' });
    assert.deepEqual(
      events.map((event) => event.kind),
      ['started', 'delta', 'sealed', failed ? 'discarded' : 'completed'],
    );
    assert.deepEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4],
    );
    assert.ok(events.every((event) => event.contextId === contextId && event.round === 1));
    if (failed) assert.equal(events.at(-1).reason, 'exception');
    else assert.equal(events.at(-1).result, final);
    const head = store.read(contextId);
    assert.equal(head.image.frame.round, 1);
    assert.deepEqual(head.image.state, { source: 'resumed' });
    assert.deepEqual(head.delivery, failed ? { status: 'failed' } : { status: 'succeeded', output: final, progress: { round: 1, currentInput: { stage: 'saved' }, phase: 'execute' } });
  });
}

test('retired second-round checkpoints are readable data but rejected before capture or output', async () => {
  const definition = {
    output,
    run: () => assert.fail('normal work cannot run'),
    checkpoint: {
      key: 'test.restored-output.second-round',
      version: 1,
      input: codec,
      output: codec,
      points: [{ name: 'saved', references: {}, state: codec, resume: { deps: {}, run: () => assert.fail('retired continuation cannot run') } }],
    },
  };
  const { runtime, store, events, contextId, captures } = restore(definition, { round: 2 });
  const saved = store.read(contextId);
  await assert.rejects(runtime.resume(contextId, {}), /retired multi-round/);
  assert.equal(captures(), 0);
  assert.equal(events.length, 0);
  assert.equal(store.read(contextId), saved);
  assert.equal(runtime.running, false);
});
