import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as runtime from '@capix/server-runtime';
import * as construction from '@capix/server-runtime/construction';
import * as content from '@capix/server-runtime/content';
import * as recording from '@capix/server-runtime/recording';
import * as protocol from '@capix/protocol';
import * as recordContract from '@capix/protocol/recording';
import { createConversationStructure, ConversationGroup, DefaultConversationDecision, PrepareConversationContext, GenerateAnswer, ExtractMemory, PrepareModelRequest, InvokeModel, AcceptModelOutput, ApplyMemory, InspectFileTask } from '@capix/observer-service/conversation';
import { initializeObserver } from '@capix/observer-service/assembly';
import { ObservationFeed } from '@capix/observer-service/observation';
import { createObserverServer } from '@capix/observer-service/http';

test('public role entrypoints resolve to the same implementations without requiring a recording carrier', () => {
  assert.equal(runtime.BoundCallable, construction.BoundCallable);
  assert.equal(runtime.Transcript, content.Transcript);
  assert.equal(runtime.bindRecording, recording.bindRecording);
  assert.equal(runtime.observeMemory, recording.observeMemory);
  assert.ok(!('observeMemory' in content));
  assert.ok(!('Recorder' in content));
  const bound = new construction.CallableBinder().bind(runtime.defineScene()({ run: { execute: () => null } }), { providers: [], source: { capture: () => null } });
  assert.ok(bound instanceof construction.BoundCallable);
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
