import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as runtime from '@weiliang0121/capix-runtime';
import * as construction from '@weiliang0121/capix-runtime/construction';
import * as transcript from '@weiliang0121/capix-transcript';
import * as memory from '@weiliang0121/capix-memory';
import * as recording from '@weiliang0121/capix-runtime/recording';
import * as records from '@weiliang0121/capix-records';
import * as protocol from '@weiliang0121/capix-protocol';
import * as recordContract from '@weiliang0121/capix-protocol/recording';

test('public role entrypoints resolve to the same implementations without requiring a recording carrier', () => {
  assert.equal(runtime.CallableBuilder, construction.CallableBuilder);
  assert.equal(runtime.BoundCallable, undefined);
  assert.equal(runtime.Transcript, undefined);
  assert.equal(typeof transcript.Transcript, 'function');
  assert.equal(typeof memory.Memories, 'function');
  assert.equal(runtime.bindRecording, recording.bindRecording);
  assert.equal(typeof records.observeMemory, 'function');
  for (const name of ['Recorder', 'RecordBook', 'RecordTree', 'CallableRecord', 'observeMemory', 'snapshotValue']) {
    assert.equal(name in runtime, false);
    assert.equal(name in recording, false);
    assert.equal(name in records, true);
  }
  assert.ok(!('observeMemory' in memory));
  assert.ok(!('Recorder' in transcript));
  const bound = new construction.CallableBuilder().build(runtime.defineScene()({ run: () => null }), new runtime.Resources());
  assert.ok(bound instanceof runtime.Scene);
  assert.equal(bound.id.length > 0, true);
  for (const assembly of ['environment', 'executionInvocationBuilder', 'operationInvocationBuilder', 'attemptInvocationBuilder']) assert.ok(!(assembly in bound));
  for (const binder of ['CallableBinder']) assert.equal(runtime[binder], construction[binder]);
  assert.ok(!('BindingEnvironment' in construction));
  assert.equal(protocol.validateExecutionRecordSnapshot, recordContract.validateExecutionRecordSnapshot);
  for (const legacy of ['Runtime', 'Execution', 'Operation', 'Attempt', 'ChangeObserver', 'RuntimeRecord']) assert.ok(!(legacy in runtime));
});
