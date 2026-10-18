import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as runtime from '@capix/server-runtime';
import * as construction from '@capix/server-runtime/construction';
import * as content from '@capix/server-runtime/content';
import * as recording from '@capix/server-runtime/recording';
import * as protocol from '@capix/protocol';
import * as recordContract from '@capix/protocol/recording';
import { ConversationExecutionDefinition, DefaultConversationDecisionDefinition, PrepareConversationContextDefinition, GenerateAnswerDefinition, ExtractMemoryDefinition, PrepareModelRequestDefinition, InvokeModelDefinition, AcceptModelOutputDefinition, ApplyMemoryDefinition, InspectFileTaskDefinition } from '@capix/observer-service/conversation';
import { initializeObserver } from '@capix/observer-service/assembly';
import { ObservationFeed } from '@capix/observer-service/observation';
import { createObserverServer } from '@capix/observer-service/http';

test('public role entrypoints resolve to the same implementations without requiring a recording carrier', () => {
  assert.equal(runtime.BoundRuntime, construction.BoundRuntime);
  assert.equal(runtime.Transcript, content.Transcript);
  assert.equal(runtime.bindRecording, recording.bindRecording);
  assert.equal(runtime.observeMemory, recording.observeMemory);
  assert.ok(!('observeMemory' in content));
  assert.ok(!('Recorder' in content));
  const bound = construction.createBoundRuntime();
  assert.ok(bound instanceof construction.BoundRuntime);
  assert.equal(bound.id.length > 0, true);
  for (const assembly of ['environment', 'executionInvocationBuilder', 'operationInvocationBuilder', 'attemptInvocationBuilder']) assert.ok(!(assembly in bound));
  for (const binder of ['RuntimeBinder', 'ExecutionBinder', 'OperationBinder', 'AttemptBinder']) assert.equal(runtime[binder], construction[binder]);
  assert.ok(!('BindingEnvironment' in construction));
  assert.equal(protocol.validateExecutionRecordSnapshot, recordContract.validateExecutionRecordSnapshot);
  for (const legacy of ['Runtime', 'Execution', 'Operation', 'Attempt', 'ChangeObserver', 'RuntimeRecord']) assert.ok(!(legacy in runtime));
});

test('service public declarations expose all supplied child operations and actions for composition', () => {
  const operations = { preparation: new PrepareConversationContextDefinition(), generation: new GenerateAnswerDefinition(), extraction: new ExtractMemoryDefinition(), decision: new DefaultConversationDecisionDefinition({ files: false }) };
  const definition = new ConversationExecutionDefinition(operations);
  assert.deepEqual(definition.children, Object.values(operations));
  for (const action of [new PrepareModelRequestDefinition(), new InvokeModelDefinition(), new AcceptModelOutputDefinition({ schema: {}, accept: (input) => input.output.content }), new ApplyMemoryDefinition(), new InspectFileTaskDefinition()]) assert.equal(action.level, 'attempt');
  assert.equal(typeof initializeObserver, 'function');
  assert.equal(typeof ObservationFeed, 'function');
  assert.equal(typeof createObserverServer, 'function');
});
