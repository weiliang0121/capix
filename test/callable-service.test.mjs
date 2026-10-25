import { createConversationRunner } from './fixtures/conversation-runner.mjs';
import { installCallable } from './fixtures/driver.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { defineScene, defineGroup, defineNode, Driver, ProgressChannel, bindRecording, Recorder, RecordBook } from '@capix/server-runtime';
import { createConversationStructure, ConversationGroup, PrepareConversationContext, GenerateAnswer, ExtractMemory, DefaultConversationDecision, acceptConversationRequest, conversationSceneRequests, ModelInteractions, ModelSource, initializeObserver, observeExecution, observeOverview, subscribeExecutions } from '@capix/observer-service';
import { validateExecutionRecordSnapshot } from '@capix/protocol';
import { createEnvironment } from './fixtures/environment.mjs';
import { ObservationReplica } from '@capix/client-runtime';
import { baseline } from './client/fixtures.mjs';
import { projectExecution } from '../apps/observer/.test-dist/observation/project.js';

const settings = { model: 'fixture', contextBudget: 32768, maxOutputTokens: 512, timeoutMs: 1000 };
const input = { messages: [{ role: 'user', content: 'a deterministic conversation' }] };
const provider = {
  async invoke(_request, purpose) {
    return { id: 'fixture', model: 'fixture', content: JSON.stringify(purpose === 'memory' ? { memories: [] } : { kind: 'answer', content: 'answer' }), finishReason: 'stop', usage: null };
  },
};

test('Scene members share Callable behavior, while only the exactly bound task publishes conversation progress', async (t) => {
  const entities = createEnvironment();
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder);
  const model = new ModelInteractions(new ModelSource(provider));
  t.after(() => model.close());
  const definition = createConversationStructure();
  const node = defineNode()({ name: 'scene-health-check', run: () => 'ready' });
  const group = defineGroup()({ name: 'unrelated-group', members: [], run: () => 'ready' });
  const original = definition.scene.run;
  definition.scene.add(node, group);
  Object.assign(definition.scene, {
    deps: definition.scene.deps,
    run: async function (work) {
      for (const member of [node, group]) {
        const call = work.children.create(member, null);
        await call.run();
        await call.accept((value) => value);
      }
      return original(work);
    },
  });

  const runner = createConversationRunner(definition, entities, model, { observations: [recording] });
  const progress = [];
  const activity = [];
  await runner.run(input, {
    settings,
    progress: new ProgressChannel({
      receive: (fact) => {
        progress.push(fact);
      },
    }),
    activity: new ProgressChannel({
      receive: (fact) => {
        activity.push(fact);
      },
    }),
  });
  assert.equal(progress.filter((fact) => fact.kind === 'execution').length, 1);
  const tasks = [...recorder.book.values()].filter((record) => record.kind === 'invocation' && record.role === 'conversation-task');
  assert.equal(tasks.length, 1);
  const sceneRecord = recorder.book.values().find((record) => record.kind === 'invocation' && record.structureKind === 'scene');
  const siblings = recorder.tree.children(sceneRecord.id).filter((record) => record.kind === 'invocation');
  assert.deepEqual(
    siblings.map((record) => record.structureKind),
    ['node', 'group', 'group'],
  );
  assert.equal(progress.find((fact) => fact.kind === 'execution').contextId, tasks[0].contextId);
  assert.ok(activity.some((fact) => fact.identity.contextId === siblings[0].contextId));
  assert.deepEqual(
    entities.transcript.snapshot().map((message) => message.role),
    ['user', 'assistant'],
  );
});

test('task snapshots preserve actual nested calls and receive final Scene acceptance without exposing it as another task', async (t) => {
  const environment = initializeObserver(provider);
  t.after(() => environment.close());
  const snapshots = [];
  const stop = subscribeExecutions(environment.records.installation, (snapshot) => snapshots.push(snapshot));
  t.after(stop);
  const result = await observeExecution(environment.runner, environment.records.installation, input, { settings });
  validateExecutionRecordSnapshot(result);
  assert.equal(result.execution.role, 'conversation-task');
  assert.equal(result.execution.structureKind, 'group');
  assert.ok(result.calls.filter((call) => call.structureKind === 'group').length > 2);
  assert.equal(result.calls.filter((call) => call.role === 'conversation-task').length, 1);
  assert.equal(result.rootCall.structureKind, 'scene');
  assert.equal(result.rootCall.status, 'succeeded');
  assert.equal(snapshots.at(-1).rootCall.value.relationChanges.at(-1).change.kind, 'accepted');
  assert.ok(snapshots.some((snapshot) => snapshot.rootCall.value.relationChanges.at(-1)?.change.kind === 'receiving'));
  assert.equal(observeOverview(environment).executions.length, 1);
  const ids = new Set(result.calls.map((call) => call.id));
  assert.ok(result.calls.every((call) => call.id === result.execution.id || ids.has(call.parentId)));
});

test('a conversation task nested under multiple groups retains its full ancestry through service, client and application projection', async (t) => {
  const entities = createEnvironment();
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder);
  const model = new ModelInteractions(new ModelSource(provider));
  t.after(() => model.close());
  const capabilities = { preparation: new PrepareConversationContext(), generation: new GenerateAnswer(), extraction: new ExtractMemory(), decision: new DefaultConversationDecision({ files: false }) };
  const conversation = new ConversationGroup(capabilities);
  const inner = defineGroup()({
    name: 'inner',
    members: [conversation],

    deps: conversationSceneRequests,
    async run(work) {
      const accepted = acceptConversationRequest(work.input, work.resources.messages.append, false);
      const call = work.children.create(conversation, accepted);
      await call.run();
      return call.accept();
    },
  });
  const forward = (child) => ({
    async run(work) {
      const call = work.children.create(child, work.input);
      await call.run();
      return call.accept();
    },
  });
  const outer = defineGroup()({ name: 'outer', members: [inner], ...forward(inner) });
  const root = defineScene()({ name: 'nested-conversation', members: [outer], ...forward(outer) });
  const definition = { scene: root, conversation, ...capabilities };

  const runner = createConversationRunner(definition, entities, model, { observations: [recording] });
  const snapshot = await observeExecution(runner, recording, input, { settings });
  validateExecutionRecordSnapshot(snapshot);
  assert.deepEqual(
    snapshot.ancestors.map((call) => call.name),
    ['outer', 'inner'],
  );
  assert.equal(snapshot.ancestors[0].parentId, snapshot.rootCall.id);
  assert.equal(snapshot.execution.parentId, snapshot.ancestors.at(-1).id);
  assert.ok(snapshot.ancestors.every((call) => !snapshot.calls.some((own) => own.id === call.id)));
  assert.equal(observeOverview({ records: { book: recorder.book }, transcript: entities.transcript }).executions.length, 1);

  const entries = [...recorder.book.values()].map((record) => ({ kind: record.kind, data: record.toJSON() }));
  const replica = ObservationReplica.receive(undefined, baseline({ entries }));
  const received = replica.snapshots.get(snapshot.execution.id);
  assert.deepEqual(received, snapshot);
  const trace = projectExecution(received);
  assert.equal(trace.callSequence.calls.find((call) => call.id === snapshot.execution.id).caller, 'group');
  assert.equal(trace.status, 'succeeded');
});

test('a Driver may run an explicitly marked root task without a synthetic Scene parent', async () => {
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder);
  const task = defineGroup()({ name: 'root-task', run: () => ({ kind: 'answer', content: 'done' }) });
  recording.describe(task, { role: 'conversation-task' });
  const driver = new Driver({ observations: [recording] });
  const bound = driver.build(task, { providers: [], source: { capture: () => null } });
  const snapshots = [];
  const stop = subscribeExecutions(recording, (snapshot) => snapshots.push(snapshot));
  try {
    await driver.run(bound, null, {});
    const snapshot = snapshots.at(-1);
    validateExecutionRecordSnapshot(snapshot);
    assert.equal(snapshot.execution.structureKind, 'group');
    assert.equal(snapshot.rootCall, undefined);
    assert.equal(snapshot.ancestors, undefined);
    const entries = [...recorder.book.values()].map((record) => ({ kind: record.kind, data: record.toJSON() }));
    const replica = ObservationReplica.receive(undefined, baseline({ entries }));
    assert.deepEqual(replica.snapshots.get(snapshot.execution.id), snapshot);
    assert.equal(projectExecution(snapshot).callSequence.calls[0].caller, 'caller');
  } finally {
    stop();
  }
});

test('a nested task change refreshes every containing task without refreshing an unrelated sibling task', async () => {
  const recorder = new Recorder(new RecordBook());
  const recording = bindRecording(recorder);
  const leaf = defineNode()({ name: 'leaf', run: () => 'done' });
  const compose = (name, child) =>
    defineGroup()({
      name,
      members: [child],
      async run(work) {
        const call = work.children.create(child, work.input);
        await call.run();
        return call.accept((value) => value);
      },
    });
  const inner = compose('inner-task', leaf);
  const outer = compose('outer-task', inner);
  const sibling = defineGroup()({ name: 'sibling-task', run: () => 'sibling' });
  for (const task of [inner, outer, sibling]) recording.describe(task, { role: 'conversation-task' });
  const scene = defineScene()({
    members: [sibling, outer],

    async run(work) {
      for (const member of [sibling, outer]) {
        const call = work.children.create(member, null);
        await call.run();
        await call.accept((value) => value);
      }
      return null;
    },
  });
  let changedOwner;
  const published = [];
  const track = recorder.subscribe((record) => {
    changedOwner = record.kind === 'invocation-boundary' ? record.callId : record.id;
  });
  const stop = subscribeExecutions(recording, (snapshot) => published.push({ owner: changedOwner, task: snapshot.execution.id }));
  try {
    const driver = installCallable(scene, { providers: [], source: { capture: () => null }, observations: [recording] });
    await driver.run(null, {});
    const byName = new Map([...recorder.book.values()].filter((record) => record.kind === 'invocation').map((record) => [record.name, record]));
    const leafRecord = byName.get('leaf');
    const related = [byName.get('inner-task').id, byName.get('outer-task').id].sort();
    assert.deepEqual([...new Set(published.filter((change) => change.owner === leafRecord.id).map((change) => change.task))].sort(), related);
    const entries = [...recorder.book.values()].map((record) => ({ kind: record.kind, data: record.toJSON() }));
    const previous = ObservationReplica.receive(undefined, baseline({ entries }));
    const replacement = { kind: 'invocation', data: { ...leafRecord.toJSON(), value: { ...leafRecord.value, input: 'updated fixture input' } } };
    const next = ObservationReplica.receive(previous, { type: 'delta', scopeId: previous.scopeId, sequence: 1, changes: [{ type: 'record', recorderId: previous.recorder.id, revision: 1, occurredAt: leafRecord.value.startedAt, change: { kind: 'replaced', entry: replacement } }] });
    assert.deepEqual([...next.updates.keys()].sort(), related);
    assert.equal(next.snapshots.get(byName.get('sibling-task').id), previous.snapshots.get(byName.get('sibling-task').id));
  } finally {
    stop();
    track();
  }
});
