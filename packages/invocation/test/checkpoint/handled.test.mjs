import assert from 'node:assert/strict';

import { test } from 'node:test';

import { cloneCheckpointImage } from '@weiliang0121/capix-checkpoint';

import { decodeCheckpointFrame } from '@weiliang0121/capix-invocation';

const iso = '2026-10-25T00:00:00.000Z';

const codec = { encode: (value) => value, decode: (value) => value };

const binding = { position: 0, childPosition: 0, check: (value) => assert.equal(typeof value?.iso, 'string'), codec: { encode: (value) => value.iso, decode: (value) => ({ iso: value }) } };

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

const decode = (source, receptions = [binding]) => decodeCheckpointFrame(cloneCheckpointImage(source).frame, { input: codec, output: codec }, [{ kind: 'node' }], receptions);

test('v6 keeps a same-round failure and its typed handled result as independent facts', () => {
  const decoded = decode(image());
  const state = decoded.children[0].state;
  assert.equal(state.kind, 'failed');
  assert.equal(state.failure.kind, 'error');
  assert.equal(state.reception.kind, 'handled');
  assert.equal(state.reception.output.iso, iso);
  assert.equal(state.error instanceof Error, false);
  const raw = image();
  raw.frame.children[0].state.reception = { kind: 'handled' };
  assert.equal(decode(raw, []).children[0].state.reception.output, undefined);
});

test('handled undefined has an explicit codec and cannot be confused with missing handling', () => {
  const source = image();
  source.frame.children[0].state.reception.output = null;
  const receptions = [
    {
      ...binding,
      check: (value) => assert.equal(value, undefined),
      codec: {
        encode: () => null,
        decode: (value) => {
          assert.equal(value, null);
          return undefined;
        },
      },
    },
  ];
  const handled = decode(source, receptions).children[0].state.reception;
  assert.equal(handled.kind, 'handled');
  assert.equal(Object.hasOwn(handled, 'output'), true);
  assert.equal(handled.output, undefined);
});

test('handled codecs remain attached to the exact parent reception and child positions', () => {
  assert.throws(() => decode(image(), []), /reception contract position/);
  assert.throws(() => decode(image(), [{ ...binding, childPosition: 1 }]), /child declaration/);
  assert.throws(() => decode(image(), [{ ...binding, codec: { ...binding.codec, decode: () => ({ invalid: true }) } }]), /assertion|equal/i);
});
