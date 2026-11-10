import assert from 'node:assert/strict';

import { test } from 'node:test';

import { CallableRecord, Recorder, RecordBook, RecordingRootRecord, RuntimeCallRecord, ExecutionRecord } from '@weiliang0121/capix-records';

const startedAt = '2026-10-20T00:00:00.000Z';

const create = (parentId, kind, contextId, role) => new CallableRecord({ parentId, contextId, structureKind: kind, ...(role ? { role } : {}) }, { input: {}, startedAt });

test('callable recording preserves a direct scene-to-node tree without synthetic levels', () => {
  const recorder = new Recorder(new RecordBook());
  const root = recorder.add(new RecordingRootRecord({ createdAt: startedAt }));
  const scene = recorder.add(create(root.id, 'scene', 'scene-call'));
  const node = recorder.add(create(scene.id, 'node', 'node-call'));
  assert.throws(() => recorder.add(create(scene.id, 'scene', 'scene-member')));
  assert.equal(node.parentId, scene.id);
  assert.equal([...recorder.book.values()].length, 3);
  const restored = RecordBook.restore(recorder.book.exportState());
  assert.equal(restored.get(node.id).structureKind, 'node');
  assert.equal(restored.get(node.id).parentId, scene.id);
});

test('group task role is metadata and does not require a scene parent', () => {
  const recorder = new Recorder(new RecordBook());
  const root = recorder.add(new RecordingRootRecord({ createdAt: startedAt }));
  const group = recorder.add(create(root.id, 'group', 'root-group', 'conversation-task'));
  recorder.add(create(group.id, 'group', 'nested'));
  assert.equal(group.role, 'conversation-task');
});

test('legacy invocation records remain readable alongside callable records', () => {
  const recorder = new Recorder(new RecordBook());
  const root = recorder.add(new RecordingRootRecord({ createdAt: startedAt }));
  const runtime = recorder.add(new RuntimeCallRecord('legacy-r', 'runtime-instance', { input: {}, startedAt }, root.id));
  const execution = recorder.add(new ExecutionRecord('legacy-e', { input: {}, startedAt }, runtime.id));
  const restored = RecordBook.restore(recorder.book.exportState());
  assert.equal(restored.get(execution.id).kind, 'execution');
  assert.equal(restored.get(runtime.id).kind, 'runtime-call');
});
