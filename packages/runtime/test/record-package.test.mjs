import assert from 'node:assert/strict';

import { test } from 'node:test';

import { Resource } from '@weiliang0121/capix-resources';

import { CallableRecord, InvocationBoundaryRecord, RecordBook, Recorder, RecordResource, ResourceRecord } from '@weiliang0121/capix-records';

import { RecordWriterResource } from '@weiliang0121/capix-records/construction';

import { Node, Scene } from '@weiliang0121/capix-structure';

import { Runner, Resources } from '@weiliang0121/capix-runtime';

import { bindRecording } from '@weiliang0121/capix-runtime/recording';

import { readOutput } from '@weiliang0121/capix-records/data';

test('automatic recording uses independent writer windows without changing results or recording itself', async () => {
  const recorder = new Recorder(new RecordBook());
  const installation = bindRecording(recorder);
  let created;
  const node = new Node({
    deps: { records: RecordResource.write.request() },
    run: (work) => {
      created = work.resources.records.create({ note: 'business content' });
      return work.input;
    },
  });
  const resources = new Resources().register(new Resource(recorder), RecordResource.write);
  const runner = new Runner(new Scene(node), resources, undefined, { observations: [installation] }).build();
  const output = { content: 'same reference' };
  assert.deepEqual(await runner.run(output), output);
  const records = [...recorder.book.values()];
  const calls = records.filter((record) => record instanceof CallableRecord);
  const scene = calls.find((record) => record.structureKind === 'scene');
  const child = calls.find((record) => record.structureKind === 'node');
  assert.equal(calls.length, 2);
  assert.equal(scene.parentId, installation.root.id);
  assert.equal(child.parentId, scene.id);
  assert.ok(scene.childIds.includes(child.id));
  for (const call of calls) {
    assert.equal(call.status, 'succeeded');
    assert.deepEqual(readOutput(call.value), output);
    assert.equal(call.value.resultOf, 2);
    assert.deepEqual(
      records.filter((record) => record instanceof InvocationBoundaryRecord && record.callId === call.id).map((record) => record.value.type),
      ['call', 'return'],
    );
  }
  assert.equal(recorder.book.get(created.data.id).kind, 'custom');
  const resourceFacts = records.filter((record) => record instanceof ResourceRecord);
  assert.deepEqual(
    resourceFacts.map((record) => record.phase),
    ['bound', 'available', 'started', 'returned'],
  );
  assert.ok(resourceFacts.every((record) => record.access === 'records.write'));
  assert.equal(
    resourceFacts.some((record) => record.access === 'records.construct'),
    false,
  );
});

test('the automatic recording installation cannot supply its host writer to business work', () => {
  const recorder = new Recorder(new RecordBook());
  const node = new Node({ deps: { writer: RecordWriterResource.request() }, run: () => assert.fail('unbound business must not execute') });
  assert.throws(() => new Runner(new Scene(node), new Resources(), undefined, { observations: [bindRecording(recorder)] }).build(), /Expected one resource provider/);
});

test('record write failure follows isolate or propagate without replaying successful business work', async () => {
  for (const failure of ['isolate', 'propagate']) {
    const cause = new Error(`reject ${failure} record return`);
    let rejectedWrites = 0;
    class RejectingRecorder extends Recorder {
      update(record, apply, describe) {
        if (record instanceof CallableRecord && record.structureKind === 'node' && record.value.processes.length === 1) {
          rejectedWrites++;
          throw cause;
        }
        return super.update(record, apply, describe);
      }
    }
    const recorder = new RejectingRecorder(new RecordBook());
    const invalidated = [];
    const installation = bindRecording(recorder, { failure, invalidate: (error) => invalidated.push(error) });
    let executions = 0;
    const node = new Node({
      run: (work) => {
        executions++;
        return work.input;
      },
    });
    const runner = new Runner(new Scene(node), new Resources(), undefined, { observations: [installation] }).build();
    const output = { content: 'completed before recording failed' };
    if (failure === 'isolate') assert.deepEqual(await runner.run(output), output);
    else
      await assert.rejects(runner.run(output), (error) => {
        const pending = [error];
        const visited = new Set();
        while (pending.length) {
          const current = pending.pop();
          if (current === cause) return true;
          if (!current || visited.has(current)) continue;
          visited.add(current);
          pending.push(current.cause, ...(current instanceof AggregateError ? current.errors : []));
        }
        return false;
      });
    assert.equal(executions, 1);
    assert.equal(rejectedWrites, 1);
    assert.ok(invalidated.length > 0);
    assert.equal(runner.isRunning, false);
  }
});
