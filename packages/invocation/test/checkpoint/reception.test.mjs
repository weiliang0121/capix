import assert from 'node:assert/strict';

import { test } from 'node:test';

import { cloneCheckpointImage, checkpointReference } from '@weiliang0121/capix-checkpoint';

import { decodeCheckpointFrame } from '@weiliang0121/capix-invocation';

const codec = { encode: (value) => value, decode: (value) => value };

const dateBinding = { position: 0, childPosition: 0, check: (value) => assert.ok(typeof value?.iso === 'string' && Number.isFinite(Date.parse(value.iso))), codec: { encode: (value) => value.iso, decode: (value) => ({ iso: value }) } };

function image(reception = { kind: 'accepted', contract: { position: 0 }, output: '2026-01-01T00:00:00.000Z' }) {
  const child = { identity: { contextId: 'child', parentContextId: 'parent', kind: 'group' }, target: { position: 0 }, round: 1, order: 0, input: null, state: { kind: 'returned', output: 'raw', progress: { round: 1, currentInput: null, phase: 'receive' }, reception } };
  return { id: 'typed', formatVersion: 6, contract: { key: 'parent', version: 1 }, point: 'saved', frame: { owner: { contextId: 'parent', kind: 'scene' }, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 1, children: [child] }, state: null, references: { selected: checkpointReference(child) } };
}

const decode = (source, bindings = [dateBinding]) => decodeCheckpointFrame(cloneCheckpointImage(source).frame, { input: codec, output: codec }, [{ kind: 'group' }], bindings);

for (const kind of ['receiving', 'accepted', 'failed']) {
  test(`v6 retains the parent reception position for ${kind}`, () => {
    const source = image(kind === 'accepted' ? undefined : { kind, contract: { position: 0 } });
    if (kind === 'failed') {
      source.frame.children[0].state.reception.error = { code: 'REJECTED', message: 'business refusal' };
      source.frame.children[0].state.reception.failure = { kind: 'exception', phase: 'execute', contextId: 'parent', contract: 'refused' };
      source.frame.round = 2;
      source.frame.continuation = { fromRound: 1, stage: 'handling', reason: 'try another result', origin: { kind: 'child-reception', child: checkpointReference(source.frame.children[0]) } };
    }
    const decoded = decode(source);
    assert.deepEqual(decoded.children[0].state.reception.contract, { position: 0 });
    if (kind === 'accepted') assert.equal(Object.isFrozen(decoded.children[0].state.reception.output), true);
    else assert.equal(Object.hasOwn(decoded.children[0].state.reception, 'output'), false);
  });
}

test('typed undefined has explicit encoding while legacy raw undefined remains untagged', () => {
  const binding = {
    position: 0,
    childPosition: 0,
    check: (value) => assert.equal(value, undefined),
    codec: {
      encode: () => null,
      decode: (value) => {
        assert.equal(value, null);
        return undefined;
      },
    },
  };
  const decoded = decode(image({ kind: 'accepted', contract: { position: 0 }, output: null }), [binding]);
  const reception = decoded.children[0].state.reception;
  assert.equal(Object.hasOwn(reception, 'output'), true);
  assert.equal(reception.output, undefined);
  const raw = decode(image({ kind: 'accepted' }), []);
  assert.equal(Object.hasOwn(raw.children[0].state.reception, 'contract'), false);
  assert.equal(raw.children[0].state.reception.output, undefined);
  assert.throws(() => decode(image({ kind: 'accepted', contract: { position: 0 } }), [binding]), /requires encoded output/);
});

test('decoding rejects unregistered reception positions, other child declarations and invalid decoded values', () => {
  assert.throws(() => decode(image(), []), /reception contract position/);
  assert.throws(() => decode(image(), [{ ...dateBinding, position: 1 }]), /reception contract position/);
  assert.throws(() => decode(image(), [{ ...dateBinding, childPosition: 1 }]), /child declaration/);
  assert.throws(() => decode(image(), [{ ...dateBinding, codec: { ...dateBinding.codec, decode: () => ({ invalid: true }) } }]), /assertion|iso/i);
  assert.throws(
    () =>
      decode(image(), [
        {
          ...dateBinding,
          codec: {
            ...dateBinding.codec,
            decode: () => {
              throw new Error('rejected encoding');
            },
          },
        },
      ]),
    /rejected encoding/,
  );
  for (const contract of [{ position: -1 }, { position: 0, codec: 'guessed' }, {}, null]) assert.throws(() => cloneCheckpointImage(image({ kind: 'accepted', contract, output: null })), /Invalid checkpoint/);
  assert.throws(() => cloneCheckpointImage(image({ kind: 'pending', contract: { position: 0 } })), /reception contract position/);
});
