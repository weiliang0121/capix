import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cloneCheckpointImage } from '@capix/server-runtime';

function image(kind = 'group') {
  return {
    id: 'checkpoint',
    formatVersion: 5,
    contract: { key: 'composition', version: 1 },
    point: 'waiting',
    state: {},
    references: {},
    frame: {
      owner: { contextId: 'parent', kind },
      round: 1,
      phase: 'execute',
      input: {},
      currentInput: {},
      nextChildOrder: 1,
      children: [{ identity: { contextId: 'child', parentContextId: 'parent', kind: 'node' }, target: { position: 0 }, round: 1, order: 0, input: {}, state: { kind: 'returned', output: 'ok', progress: { round: 1, phase: 'receive', currentInput: {} }, reception: { kind: 'pending' } } }],
    },
  };
}

test('callable checkpoint accepts direct scene-to-node and group-to-node relationships', () => {
  for (const kind of ['scene', 'group']) assert.equal(cloneCheckpointImage(image(kind)).frame.children[0].identity.kind, 'node');
});

test('callable checkpoint rejects legacy formats without upgrading or replaying', () => {
  for (const formatVersion of [1, 2, 3, 4]) assert.throws(() => cloneCheckpointImage({ ...image(), formatVersion }), /formatVersion 5/);
});

test('callable checkpoint keeps direct ownership and leaf constraints', () => {
  assert.throws(() => cloneCheckpointImage(image('node')));
  const foreign = image();
  foreign.frame.children[0].identity.parentContextId = 'another';
  assert.throws(() => cloneCheckpointImage(foreign));
  const legacyIdentity = image();
  delete legacyIdentity.frame.owner.kind;
  legacyIdentity.frame.owner.level = 'operation';
  assert.throws(() => cloneCheckpointImage(legacyIdentity));
});
