import { installCallable } from './fixtures/driver.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { defineScene, defineGroup, defineNode, Driver, ProgressChannel, invocationRecording, bindRecording, Recorder, RecordBook } from '@capix/server-runtime';
import { ConversationSceneDefinition, ModelInteractions, ModelSource, bindConversation, initializeObserver, observeExecution, observeOverview, subscribeExecutions } from '@capix/observer-service';
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
  const definition = new ConversationSceneDefinition();
  const node = defineNode()({ name: 'scene-health-check', observation: [invocationRecording()], run: { execute: () => 'ready' } });
  const group = defineGroup()({ name: 'unrelated-group', members: [], observation: [invocationRecording()], run: { execute: () => 'ready' } });
  const original = definition.run;
  definition.members = [node, group, ...definition.members];
  definition.run = {
    ...original,
    uses: definition.members,
    async execute(work) {
      for (const member of [node, group]) {
        const call = work.children.create(member, null);
        await call.run();
        await call.accept((value) => value);
      }
      return original.execute(work);
    },
  };
  const driver = new Driver({ observations: [recording] });
  const scene = bindConversation(driver, definition, entities, model);
  const progress = [];
  const activity = [];
  await driver.run(scene, input, {
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
  const stop = subscribeExecutions(environment.recording, (snapshot) => snapshots.push(snapshot));
  t.after(stop);
  const result = await observeExecution(environment.driver, environment.scene, environment.recording, input, { settings });
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
  const definition = new ConversationSceneDefinition();
  const original = definition.run;
  const inner = defineGroup()({ name: 'inner', members: definition.members, observation: [invocationRecording()], run: original });
  const wrapper = (name, child) =>
    defineGroup()({
      name,
      members: [child],
      observation: [invocationRecording()],
      run: {
        uses: [child],
        async execute(work) {
          const call = work.children.create(child, work.input);
          await call.run();
          return call.accept((value) => value);
        },
      },
    });
  const outer = wrapper('outer', inner);
  definition.members = [outer];
  definition.run = wrapper('root-entry', outer).run;
  // This test exercises a different declared topology, without promising the original Scene CP.
  definition.checkpoint = undefined;
  const driver = new Driver({ observations: [recording] });
  const scene = bindConversation(driver, definition, entities, model);
  const snapshot = await observeExecution(driver, scene, recording, input, { settings });
  validateExecutionRecordSnapshot(snapshot);
  assert.deepEqual(
    snapshot.ancestors.map((call) => call.name),
    ['outer', 'inner'],
  );
  assert.equal(snapshot.ancestors[0].parentId, snapshot.rootCall.id);
  assert.equal(snapshot.execution.parentId, snapshot.ancestors.at(-1).id);
  assert.ok(snapshot.ancestors.every((call) => !snapshot.calls.some((own) => own.id === call.id)));
  assert.equal(observeOverview({ book: recorder.book, transcript: entities.transcript }).executions.length, 1);

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
  const task = defineGroup()({ name: 'root-task', observation: [invocationRecording({ role: 'conversation-task' })], run: { execute: () => ({ kind: 'answer', content: 'done' }) } });
  const driver = new Driver({ observations: [recording] });
  const bound = driver.bind(task, { providers: [], source: { capture: () => null } });
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
  const leaf = defineNode()({ name: 'leaf', observation: [invocationRecording()], run: { execute: () => 'done' } });
  const compose = (name, child) =>
    defineGroup()({
      name,
      members: [child],
      observation: [invocationRecording({ role: 'conversation-task' })],
      run: {
        async execute(work) {
          const call = work.children.create(child, work.input);
          await call.run();
          return call.accept((value) => value);
        },
      },
    });
  const inner = compose('inner-task', leaf);
  const outer = compose('outer-task', inner);
  const sibling = defineGroup()({ name: 'sibling-task', observation: [invocationRecording({ role: 'conversation-task' })], run: { execute: () => 'sibling' } });
  const scene = defineScene()({
    members: [sibling, outer],
    observation: [invocationRecording()],
    run: {
      async execute(work) {
        for (const member of [sibling, outer]) {
          const call = work.children.create(member, null);
          await call.run();
          await call.accept((value) => value);
        }
        return null;
      },
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
