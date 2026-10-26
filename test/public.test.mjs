import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as runtime from '@capix/server-runtime';
import * as construction from '@capix/server-runtime/construction';
import * as transcript from '@capix/transcript';
import * as memory from '@capix/memory';
import * as recording from '@capix/server-runtime/recording';
import * as records from '@capix/records';
import * as protocol from '@capix/protocol';
import * as recordContract from '@capix/protocol/recording';
import { createConversationStructure, ConversationGroup, DefaultConversationDecision, PrepareConversationContext, GenerateAnswer, ExtractMemory, PrepareModelRequest, InvokeModel, AcceptModelOutput, ApplyMemory, InspectFileTask } from '@capix/observer-service/conversation';
import { initializeObserver } from '@capix/observer-service/assembly';
import { ObservationFeed } from '@capix/observer-service/observation';
import { createObserverServer } from '@capix/observer-service/http';

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
  const bound = new construction.CallableBuilder().build(runtime.defineScene()({ run: () => null }), { providers: [], source: { capture: () => null } });
  assert.ok(bound instanceof runtime.Scene);
  assert.equal(bound.id.length > 0, true);
  for (const assembly of ['environment', 'executionInvocationBuilder', 'operationInvocationBuilder', 'attemptInvocationBuilder']) assert.ok(!(assembly in bound));
  for (const binder of ['CallableBinder']) assert.equal(runtime[binder], construction[binder]);
  assert.ok(!('BindingEnvironment' in construction));
  assert.equal(protocol.validateExecutionRecordSnapshot, recordContract.validateExecutionRecordSnapshot);
  for (const legacy of ['Runtime', 'Execution', 'Operation', 'Attempt', 'ChangeObserver', 'RuntimeRecord']) assert.ok(!(legacy in runtime));
});

test('service public structures expose supplied members as concrete callable objects', () => {
  const operations = { preparation: new PrepareConversationContext(), generation: new GenerateAnswer(), extraction: new ExtractMemory(), decision: new DefaultConversationDecision({ files: false }) };
  const definition = new ConversationGroup(operations);
  assert.ok(definition instanceof runtime.Group);
  assert.deepEqual(definition.members, Object.values(operations));
  for (const action of [new PrepareModelRequest(() => null), new InvokeModel('answer'), new AcceptModelOutput({ schema: {}, accept: (input) => input.output.content }), new ApplyMemory(), new InspectFileTask()]) {
    assert.ok(action instanceof runtime.Node);
    assert.equal(action.kind, 'node');
  }
  assert.equal(typeof initializeObserver, 'function');
  assert.equal(typeof ObservationFeed, 'function');
  assert.equal(typeof createObserverServer, 'function');
});

test('conversation construction retains exact binding targets without navigating private business fields', () => {
  const structure = createConversationStructure({ files: true });
  assert.ok(structure.scene instanceof runtime.Scene);
  assert.equal(structure.scene.members[0], structure.conversation);
  for (const target of [structure.preparation, structure.generation, structure.extraction, structure.decision, structure.preflight, structure.document, structure.save]) assert.ok(structure.conversation.members.includes(target));
  assert.equal(structure.scene.taskDefinition, undefined);
  assert.equal(structure.conversation.operationDefinitions, undefined);
});
