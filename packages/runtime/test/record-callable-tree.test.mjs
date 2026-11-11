import { installCallable } from './fixtures/driver.mjs';

import assert from 'node:assert/strict';

import { test } from 'node:test';

import { bindRecording, invocationRecording } from '@weiliang0121/capix-runtime/recording';

import { CallableRecord, CallableRecordHelper, Recorder, RecordBook } from '@weiliang0121/capix-records';

import { defineScene, defineGroup, defineNode } from '@weiliang0121/capix-runtime';

import { validateExecutionRecordSnapshot } from '@weiliang0121/capix-records/data';

const startedAt = '2026-10-20T00:00:00.000Z';

const create = (parentId, kind, contextId, role) => new CallableRecord({ parentId, contextId, structureKind: kind, ...(role ? { role } : {}) }, { input: {}, startedAt });

test('live recording and generic subtree details follow direct members and restore without level inference', async () => {
  const recorder = new Recorder(new RecordBook());
  const recorded = (role) => [invocationRecording(role ? { role } : {}, { failure: 'propagate' })];
  const read = () => 'read value';
  const node = defineNode()({ name: 'read', run: read });
  const nestedNode = defineNode()({ name: 'read', run: read });
  const nested = defineGroup()({
    name: 'inner',
    members: [nestedNode],
    async run(work) {
      const call = work.children.create(nestedNode, null);
      await call.run();
      return call.accept();
    },
  });
  const scene = defineScene()({
    members: [node, nested],
    async run(work) {
      const direct = work.children.create(node, null);
      await direct.run();
      await direct.accept();
      const child = work.children.create(nested, null);
      await child.run();
      return child.accept();
    },
  });
  const driver = installCallable(scene, { providers: [], source: { capture: () => null }, observations: [bindRecording(recorder, { failure: 'propagate' })] });
  assert.equal(await driver.run(null, {}), 'read value');
  const calls = [...recorder.book.values()].filter((record) => record instanceof CallableRecord);
  assert.deepEqual(
    calls.map((record) => record.structureKind),
    ['scene', 'node', 'group', 'node'],
  );
  const selected = calls.find((record) => record.name === 'inner');
  const snapshot = CallableRecordHelper.snapshot(recorder, selected.id);
  assert.equal(snapshot.execution.id, selected.id);
  assert.deepEqual(
    snapshot.calls.map((record) => record.structureKind),
    ['group', 'node'],
  );
  validateExecutionRecordSnapshot(snapshot);
  const leaf = calls.find((record) => record.parentId === selected.id);
  const deep = CallableRecordHelper.snapshot(recorder, leaf.id);
  assert.deepEqual(
    deep.calls.map((record) => record.id),
    [leaf.id],
  );
  assert.deepEqual(
    deep.ancestors.map((record) => record.id),
    [selected.id],
  );
  assert.equal(deep.rootCall.structureKind, 'scene');
  validateExecutionRecordSnapshot(deep);
  const historical = RecordBook.restore(recorder.book.exportState());
  assert.equal(historical.get(selected.id).status, 'succeeded');
});
