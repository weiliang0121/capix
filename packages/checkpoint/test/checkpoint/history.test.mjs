import assert from 'node:assert/strict';

import { test } from 'node:test';

import { cloneCheckpointImage } from '@weiliang0121/capix-checkpoint';

function historicalImage(reception = false, typed = false) {
  const ref = { contextId: 'child', parentContextId: 'root', parentRound: 1, order: 0, target: { position: 0 } };
  const diagnostic = { code: 'fixture.rejected', message: reception ? 'parent refused output' : 'invalid output' };
  const failure = { kind: 'exception', contextId: reception ? 'root' : 'child', phase: 'execute', contract: 'fixture.rejected' };
  const progress = { round: 1, currentInput: {}, phase: 'execute' };
  const child = { target: { position: 0 }, identity: { contextId: 'child', parentContextId: 'root', kind: 'group' }, contract: { key: 'fixture.history.child', version: 1 }, round: 1, order: 0, input: {}, state: reception ? { kind: 'returned', output: { answer: 'successful child output' }, progress, reception: { kind: 'failed', ...(typed ? { contract: { position: 0 } } : {}), error: diagnostic, failure } } : { kind: 'failed', progress, error: diagnostic, failure } };
  return { id: 'history', formatVersion: 5, contract: { key: 'fixture.history.root', version: 1 }, point: 'second', frame: { owner: { contextId: 'root', kind: 'scene' }, round: 2, phase: 'execute', input: {}, currentInput: { retry: true }, nextChildOrder: 1, children: [child], continuation: { fromRound: 1, stage: 'handling', reason: 'historical retry', origin: { kind: reception ? 'child-reception' : 'child-return', child: ref } } }, state: null, references: {} };
}

test('historical child failures still validate age, original child identity, kind and phase', () => {
  const image = { ...historicalImage(), formatVersion: 6 };
  for (const alter of [
    (value) => {
      value.frame.children[0].round = 2;
    },
    (value) => {
      value.frame.children[0].state.failure.kind = 'error';
    },
    (value) => {
      value.frame.children[0].state.failure.contextId = 'other';
    },
    (value) => {
      delete value.frame.children[0].state.failure.contract;
    },
    (value) => {
      value.frame.children[0].state.failure.phase = 'control';
    },
  ]) {
    const changed = structuredClone(image);
    alter(changed);
    assert.throws(() => cloneCheckpointImage(changed), /historical child failure/);
  }
});

test('historical failed receptions must match the accepted continuation origin', () => {
  const image = { ...historicalImage(true, true), formatVersion: 6 };
  for (const alter of [
    (value) => {
      value.frame.children[0].state.reception.failure.contextId = 'child';
    },
    (value) => {
      value.frame.continuation.origin.kind = 'child-return';
    },
    (value) => {
      value.frame.continuation.origin.child.contextId = 'other';
    },
  ]) {
    const changed = structuredClone(image);
    alter(changed);
    assert.throws(() => cloneCheckpointImage(changed));
  }
});
