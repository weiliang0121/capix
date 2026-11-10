import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';

import { test } from 'node:test';

import { cloneCheckpointImage, cloneCheckpointHead, checkpointReference, checkpointReferenceChild, MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';

function image() {
  const child = { identity: { contextId: 'child', parentContextId: 'parent', kind: 'node' }, target: { position: 0 }, round: 1, order: 0, input: { request: 'initial' }, state: { kind: 'returned', output: 'delivered', progress: { round: 2, currentInput: { request: 'child-second' }, phase: 'receive' }, reception: { kind: 'accepted', output: { selected: true } } } };
  return { id: 'point-image', formatVersion: 6, contract: { key: 'parent-contract', version: 1 }, point: 'saved', frame: { owner: { contextId: 'parent', kind: 'group' }, round: 1, phase: 'execute', input: {}, currentInput: {}, nextChildOrder: 1, children: [child] }, state: { selected: true }, references: { chosen: checkpointReference(child), all: [checkpointReference(child)], repeated: checkpointReference(child) } };
}

const copy = (value) => JSON.parse(JSON.stringify(value));

function handledReception() {
  const value = image();
  const child = value.frame.children[0];
  child.state.reception = { kind: 'failed', error: { code: 'REJECTED', message: 'parent rejected output' }, failure: { kind: 'exception', contextId: 'parent', phase: 'execute', contract: 'parent/rejected' } };
  value.frame.round = 2;
  value.frame.currentInput = { second: true };
  value.frame.continuation = { fromRound: 1, stage: 'handling', reason: 'use another candidate', origin: { kind: 'child-reception', child: checkpointReference(child) } };
  return value;
}

test('production v6 image preserves complete relations, child progress and repeated reference slots', () => {
  const value = image();
  const fixed = cloneCheckpointImage(value);
  assert.equal(fixed.formatVersion, 6);
  assert.equal(fixed.frame.children.length, 1);
  assert.equal(fixed.frame.children[0].state.progress.round, 2);
  assert.equal(fixed.frame.children[0].round, 1);
  assert.equal(checkpointReferenceChild(fixed.references.chosen, fixed.frame.children), fixed.frame.children[0]);
  assert.equal(checkpointReferenceChild(fixed.references.repeated, fixed.frame.children), fixed.frame.children[0]);
  value.frame.children[0].state.output = 'mutated';
  assert.equal(fixed.frame.children[0].state.output, 'delivered');
  assert.equal(Object.isFrozen(fixed.references.all), true);
});

test('production v6 survives a separate process without memory objects', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import {readFileSync} from 'node:fs'; import { cloneCheckpointImage } from '@weiliang0121/capix-checkpoint'; const value=cloneCheckpointImage(JSON.parse(readFileSync(0,'utf8'))); process.stdout.write(JSON.stringify({version:value.formatVersion,position:value.frame.children[0].target.position,ref:value.references.chosen.contextId}));"], { cwd: fileURLToPath(new URL('../../', import.meta.url)), input: JSON.stringify(image()), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { version: 6, position: 0, ref: 'child' });
});

test('production rejects v1/v2/v3/v4/v5 and malformed persistent identity without upgrading', () => {
  for (const formatVersion of [1, 2, 3, 4, 5]) {
    const prior = { ...image(), formatVersion };
    assert.throws(() => cloneCheckpointImage(prior), /formatVersion 6/);
  }
  const mutations = [
    (value) => {
      delete value.references;
    },
    (value) => {
      delete value.frame.children[0].target;
    },
    (value) => {
      value.frame.children[0].target.position = -1;
    },
    (value) => {
      value.references.chosen.contextId = 'other';
    },
    (value) => {
      value.references.chosen.parentContextId = 'other';
    },
    (value) => {
      value.references.chosen.parentRound = 2;
    },
    (value) => {
      value.references.chosen.order = 100;
    },
    (value) => {
      value.references.chosen.target.position = 1;
    },
  ];
  for (const mutate of mutations) {
    const value = copy(image());
    mutate(value);
    assert.throws(() => cloneCheckpointImage(value), /Invalid checkpoint/);
  }
});

test('production continuation is an accepted second-round fact with an accurate failure origin', () => {
  const value = handledReception();
  const restored = cloneCheckpointImage(value);
  assert.equal(restored.frame.children[0].state.output, 'delivered');
  assert.equal(restored.frame.children[0].state.reception.kind, 'failed');
  assert.equal(restored.frame.children[0].state.reception.error instanceof Error, false);
  assert.equal(Object.isFrozen(restored.frame.children[0].state.reception.error), true);
  const mutations = [
    (copy) => {
      copy.frame.round = 1;
    },
    (copy) => {
      delete copy.frame.continuation;
    },
    (copy) => {
      copy.frame.continuation.origin.kind = 'child-return';
    },
    (copy) => {
      copy.frame.continuation.origin.child.order = 1;
    },
    (copy) => {
      copy.frame.continuation.stage = 'accept';
    },
    (copy) => {
      copy.frame.children[0].state.reception.failure.kind = 'error';
    },
    (copy) => {
      copy.frame.children[0].state.reception.failure.contextId = 'child';
    },
    (copy) => {
      copy.frame.children[0].state.reception.failure.phase = 'handling';
    },
  ];
  for (const mutate of mutations) {
    const invalid = copy(value);
    mutate(invalid);
    assert.throws(() => cloneCheckpointImage(invalid), /Invalid checkpoint/);
  }
});

test('a different failed reception is not made handled by another continuation source', () => {
  const value = handledReception();
  const other = copy(value.frame.children[0]);
  other.identity.contextId = 'other-child';
  other.order = 1;
  value.frame.children.push(other);
  value.frame.nextChildOrder = 2;
  assert.throws(() => cloneCheckpointImage(value), /not the accepted continuation origin/);
});

test('complete unselected acceptance values remain strict and state cannot hide live data', () => {
  const value = image();
  value.references = {};
  value.frame.children[0].state.reception.output = new Date();
  assert.throws(() => cloneCheckpointImage(value), /live objects/);
  const withoutOutput = image();
  delete withoutOutput.frame.children[0].state.reception.output;
  assert.doesNotThrow(() => cloneCheckpointImage(withoutOutput));
});

test('waiting needs a CP contract while successful delivery without one remains valid', () => {
  assert.doesNotThrow(() => cloneCheckpointImage(image()));
  const value = image();
  value.frame.children[0].state = { kind: 'waiting' };
  assert.throws(() => cloneCheckpointImage(value), /resumable contract/);
  value.frame.children[0].contract = { key: 'child-contract', version: 1 };
  assert.doesNotThrow(() => cloneCheckpointImage(value));
});

test('v6 memory store and head validation retain independent image and final delivery budgets', () => {
  const value = image();
  value.state.padding = 'x'.repeat(5 * 1024 * 1024);
  const store = new MemoryCheckpointStore();
  const saved = store.save(value, 0);
  const completed = store.finish('parent', saved.revision, { status: 'succeeded', output: 'y'.repeat(5 * 1024 * 1024), progress: { round: 1, currentInput: {}, phase: 'receive' } });
  assert.doesNotThrow(() => cloneCheckpointHead(store.read('parent')));
  assert.throws(() => store.save({ ...value, id: 'another' }, completed.revision), { code: 'CHECKPOINT_CONFLICT' });
});
