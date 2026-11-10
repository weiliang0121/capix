import { installCallable } from '../fixtures/driver.mjs';

import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Scene } from '@weiliang0121/capix-runtime';

import { MemoryCheckpointStore, cloneCheckpointImage } from '@weiliang0121/capix-checkpoint';

function historicalImage(reception = false, typed = false) {
  const ref = { contextId: 'child', parentContextId: 'root', parentRound: 1, order: 0, target: { position: 0 } };
  const diagnostic = { code: 'fixture.rejected', message: reception ? 'parent refused output' : 'invalid output' };
  const failure = { kind: 'exception', contextId: reception ? 'root' : 'child', phase: 'execute', contract: 'fixture.rejected' };
  const progress = { round: 1, currentInput: {}, phase: 'execute' };
  const child = { target: { position: 0 }, identity: { contextId: 'child', parentContextId: 'root', kind: 'group' }, contract: { key: 'fixture.history.child', version: 1 }, round: 1, order: 0, input: {}, state: reception ? { kind: 'returned', output: { answer: 'successful child output' }, progress, reception: { kind: 'failed', ...(typed ? { contract: { position: 0 } } : {}), error: diagnostic, failure } } : { kind: 'failed', progress, error: diagnostic, failure } };
  return { id: 'history', formatVersion: 5, contract: { key: 'fixture.history.root', version: 1 }, point: 'second', frame: { owner: { contextId: 'root', kind: 'scene' }, round: 2, phase: 'execute', input: {}, currentInput: { retry: true }, nextChildOrder: 1, children: [child], continuation: { fromRound: 1, stage: 'handling', reason: 'historical retry', origin: { kind: reception ? 'child-reception' : 'child-return', child: ref } } }, state: null, references: {} };
}

for (const mode of ['child', 'raw-reception', 'typed-reception']) {
  test(`retired ${mode} format is refused without installing any history`, async () => {
    const image = historicalImage(mode !== 'child', mode === 'typed-reception');
    const before = structuredClone(image);
    assert.throws(() => cloneCheckpointImage(image), { code: 'CHECKPOINT_FORMAT_UNSUPPORTED' });
    const store = new MemoryCheckpointStore();
    assert.throws(() => store.save(image, 0), { code: 'CHECKPOINT_FORMAT_UNSUPPORTED' });
    assert.equal(store.read('root'), undefined);
    assert.deepEqual(image, before);
    let captures = 0;
    const scene = new Scene({ run: () => assert.fail('normal work cannot replay'), checkpoint: { key: 'fixture.history.root', version: 1, input: { encode: (value) => value, decode: (value) => value }, output: { encode: (value) => value, decode: (value) => value }, points: [] } });
    const runtime = installCallable(scene, {
      providers: [],
      source: {
        capture: () => {
          captures++;
          return null;
        },
      },
      checkpoints: { store: { read: () => ({ revision: 1, image }), save: () => assert.fail('must not rewrite legacy data'), finish: () => assert.fail('must not finish legacy data') } },
    });
    await assert.rejects(runtime.resume('root', {}), { code: 'CHECKPOINT_FORMAT_UNSUPPORTED' });
    assert.equal(captures, 0);
    assert.equal(runtime.running, false);
  });
}
