import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionResources } from '../../apps/observer/.test-dist/binding/resources.js';

const settings = { model: 'fixture', contextBudget: 32768 };
const fact = (parentId, supplyId, value = settings) => ({ parentId, supplyId, phase: 'available', access: 'model-settings.snapshot', value });
const snapshot = (resources) => ({ execution: { id: 'E' }, calls: [{ id: 'E' }, { id: 'O' }, { id: 'A' }], resources });

test('execution settings come from one consistent supply accessed by actual descendants', () => {
  const projected = executionResources(snapshot([fact('O', 'shared'), fact('A', 'shared', { ...settings }), fact('R', 'root', { model: 'root-only' }), fact('foreign', 'foreign', { model: 'foreign-only' })]));
  assert.equal(projected.settingsState, 'available');
  assert.deepEqual(projected.settings, settings);
  assert.equal(projected.transcriptRange, undefined);
});

test('execution settings preserve unavailable, multiple and inconsistent meanings without selecting a convenient record', () => {
  assert.equal(executionResources(snapshot([fact('R', 'root')])).settingsState, 'unavailable');
  const multiple = executionResources(snapshot([fact('O', 'first'), fact('A', 'second')]));
  assert.equal(multiple.settingsState, 'multiple');
  assert.equal(multiple.settings, undefined);
  const inconsistent = executionResources(snapshot([fact('O', 'same'), fact('A', 'same', { model: 'changed' })]));
  assert.equal(inconsistent.settingsState, 'inconsistent');
  assert.equal(inconsistent.settings, undefined);
});

test('historical E-owned configuration records remain interpretable and message range stays local to E', () => {
  const projected = executionResources(snapshot([fact('E', 'old'), { parentId: 'E', phase: 'available', access: 'transcript.fixedRange', value: { transcriptId: 'messages', start: 1, end: 3, revision: 2 } }, { parentId: 'O', phase: 'available', access: 'transcript.fixedRange', value: { transcriptId: 'different', start: 0, end: 9 } }]));
  assert.equal(projected.settingsState, 'available');
  assert.deepEqual(projected.settings, settings);
  assert.deepEqual(projected.transcriptRange, { transcriptId: 'messages', start: 1, end: 3, revision: 2 });
});
