import assert from 'node:assert/strict';

import { test } from 'node:test';

import { cloneCheckpointImage } from '@weiliang0121/capix-checkpoint';

const iso = '2026-10-25T00:00:00.000Z';

function image() {
  return {
    id: 'handled-image',
    formatVersion: 6,
    contract: { key: 'parent', version: 1 },
    point: 'handled',
    frame: {
      owner: { contextId: 'parent', kind: 'scene' },
      round: 1,
      phase: 'execute',
      input: null,
      currentInput: null,
      nextChildOrder: 1,
      children: [
        {
          identity: { contextId: 'child', parentContextId: 'parent', kind: 'node' },
          target: { position: 0 },
          round: 1,
          order: 0,
          input: null,
          state: {
            kind: 'failed',
            error: { code: 'ERROR', message: 'primary failed' },
            failure: { kind: 'error', phase: 'execute', contextId: 'child' },
            progress: { round: 1, currentInput: null, phase: 'execute' },
            reception: { kind: 'handled', contract: { position: 0 }, output: iso },
          },
        },
      ],
    },
    state: null,
    references: {},
  };
}

test('v6 rejects unfinished, misattributed or relabelled same-round failure handling', () => {
  const mutations = [
    (source) => {
      delete source.frame.children[0].state.reception;
    },
    ...['pending', 'receiving', 'accepted', 'failed'].map((kind) => (source) => {
      source.frame.children[0].state.reception.kind = kind;
    }),
    (source) => {
      source.frame.children[0].state.failure.contextId = '';
    },
    (source) => {
      source.frame.children[0].identity.parentContextId = 'another-parent';
    },
    (source) => {
      source.frame.children[0].state.failure.phase = 'imagined';
    },
    ...['setup', 'control', 'observation'].map((phase) => (source) => {
      source.frame.children[0].state.failure.phase = phase;
    }),
    (source) => {
      source.frame.children[0].state.failure.kind = 'exception';
    },
    (source) => {
      source.frame.children[0].state.output = 'pretend success';
    },
    (source) => {
      delete source.frame.children[0].state.reception.output;
    },
    (source) => {
      source.frame.children[0].state.reception.contract.position = -1;
    },
  ];
  for (const mutate of mutations) {
    const source = image();
    mutate(source);
    assert.throws(() => cloneCheckpointImage(source), /Invalid checkpoint/);
  }
  const source = image();
  source.frame.children[0].state.failure = { kind: 'exception', phase: 'execute', contextId: 'child', contract: 'bad-answer' };
  assert.equal(cloneCheckpointImage(source).frame.children[0].state.failure.kind, 'exception');
  source.formatVersion = 4;
  assert.throws(() => cloneCheckpointImage(source), /formatVersion 6/);
});
