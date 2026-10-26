import { ResourceAccessClosed } from '@capix/resources';
import { ResourceBindings } from '../fixtures/resources.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindRecording, bindInvocationObservation, invocationRecording, defineObservation, InvocationRecordAccess } from '@capix/server-runtime';
import { Recorder, RecordBook, CallableRecordHelper, CallableRecord } from '@capix/records';
import { ChangeBuffer } from '@capix/changes';

import { readOutput, validateExecutionRecordSnapshot } from '@capix/protocol';

function fixture(options) {
  const changes = new ChangeBuffer();
  const recorder = new Recorder(new RecordBook(), { changes });
  const recording = bindRecording(recorder, options);
  const create = (kind, contextId, parent, description = {}, recordDescription = {}) => {
    const declaration = invocationRecording(recordDescription, { failure: 'propagate' });
    const setup = { identity: { kind, contextId, ...(parent ? { parentContextId: parent.setup.identity.contextId } : {}) }, description, resources: new ResourceBindings({}), declarations: [declaration] };
    const call = recording.bindInvocation(setup, parent);
    const observation = bindInvocationObservation({ ...setup, resources: call.resources }, []);
    let eventSequence = 0;
    return {
      call,
      publish(change, time) {
        const failure = observation.publish({ ...change, identity: setup.identity, description, eventSequence: ++eventSequence, occurredAt: '2026-10-09T00:00:00.000Z', monotonicTime: time });
        if (failure) throw failure;
      },
    };
  };
  return { changes, recorder, recording, create };
}

test('parent acceptance has its own record projection and leaves the actual relation value unchanged', () => {
  const value = fixture();
  const seen = [];
  const runtime = value.create(
    'scene',
    'r-map',
    undefined,
    { id: 'runtime-map' },
    {
      relationAccepted(output, relation) {
        seen.push({ output, relation });
        return { key: relation.key, size: output.body.length };
      },
    },
  );
  runtime.publish({ kind: 'started', input: null }, 0);
  const child = value.create('group', 'e-map', runtime.call, {}, { output: () => ({ returned: true }) });
  const relation = { parentContextId: 'r-map', childContextId: 'e-map', parentRound: 1, key: 'document' };
  runtime.publish({ kind: 'relation', relation, change: { kind: 'attached' } }, 1);
  child.publish({ kind: 'started', input: null }, 2);
  const returned = { text: 'private original' };
  runtime.publish({ kind: 'relation', relation, change: { kind: 'returned', result: { status: 'succeeded', output: returned } } }, 3);
  runtime.publish({ kind: 'relation', relation, change: { kind: 'receiving' } }, 4);
  const accepted = { body: returned.text, extra: 'parent decision' };
  runtime.publish({ kind: 'relation', relation, change: { kind: 'accepted', output: accepted } }, 5);
  assert.deepEqual(runtime.call.record.value.relationChanges[1].change.result.output, { returned: true });
  assert.deepEqual(runtime.call.record.value.relationChanges[3].change.output, { key: 'document', size: 16 });
  assert.equal(seen[0].output, accepted);
  assert.deepEqual(accepted, { body: 'private original', extra: 'parent decision' });
  assert.equal(JSON.stringify(runtime.call.record.value).includes('private original'), false);
});
function completedPair() {
  const value = fixture();
  const runtime = value.create('scene', 'r-context', undefined, { id: 'runtime-instance' });
  runtime.publish({ kind: 'started', input: null }, 10);
  runtime.publish({ kind: 'process', processSequence: 1, round: 1, process: { stage: 'execute', type: 'start', input: null } }, 11);
  const execution = value.create('group', 'e-context', runtime.call);
  const relation = { parentContextId: 'r-context', childContextId: 'e-context', parentRound: 1, key: 'execution' };
  runtime.publish({ kind: 'relation', relation, change: { kind: 'attached' } }, 12);
  execution.publish({ kind: 'started', input: null }, 15);
  execution.publish({ kind: 'process', processSequence: 1, round: 1, process: { stage: 'execute', type: 'start', input: null } }, 16);
  execution.publish({ kind: 'process', processSequence: 2, round: 1, process: { stage: 'execute', type: 'return', output: 2 } }, 20);
  execution.publish({ kind: 'finished', state: { status: 'succeeded', output: 2 } }, 22);
  runtime.publish({ kind: 'relation', relation, change: { kind: 'returned', result: { status: 'succeeded', output: 2 } } }, 23);
  runtime.publish({ kind: 'relation', relation, change: { kind: 'receiving' } }, 24);
  runtime.publish({ kind: 'relation', relation, change: { kind: 'accepted', output: 4 } }, 25);
  runtime.publish({ kind: 'process', processSequence: 2, round: 1, process: { stage: 'execute', type: 'return', output: 4 } }, 26);
  runtime.publish({ kind: 'finished', state: { status: 'succeeded', output: 4 } }, 30);
  return { ...value, runtime, execution };
}

test('record preset keeps R invocation, E timing and parent reception distinct', () => {
  const { recorder, recording, runtime, execution, changes } = completedPair();
  const snapshot = CallableRecordHelper.snapshot(recorder, execution.call.record.id);
  validateExecutionRecordSnapshot(snapshot);
  assert.ok(runtime.call.record instanceof CallableRecord);
  assert.equal(runtime.call.record.parentId, recording.root.id);
  assert.equal(snapshot.execution.parentId, runtime.call.record.id);
  assert.equal(snapshot.rootCall.structureId, 'runtime-instance');
  assert.deepEqual(
    snapshot.boundaries.filter((event) => event.callId === snapshot.rootCall.id).map((event) => event.offsetMs),
    [0, 20],
  );
  assert.ok(snapshot.boundaries.filter((event) => event.callId === snapshot.rootCall.id).every((event) => event.executionId === undefined && event.scopeId === runtime.call.record.id));
  assert.deepEqual(
    snapshot.boundaries.filter((event) => event.callId === snapshot.execution.id).map((event) => event.offsetMs),
    [5, 12],
  );
  assert.ok(snapshot.boundaries.filter((event) => event.callId === snapshot.execution.id).every((event) => event.scopeId === runtime.call.record.id));
  const relation = snapshot.rootCall.value.relationChanges;
  assert.deepEqual(
    relation.map((entry) => entry.change.kind),
    ['attached', 'returned', 'receiving', 'accepted'],
  );
  assert.equal(relation[0].childId, undefined);
  assert.equal(relation[1].childId, snapshot.execution.id);
  assert.equal(relation[1].change.result.output, 2);
  assert.equal(relation[3].change.output, 4);
  assert.equal(readOutput(snapshot.rootCall.value), 4);
  assert.equal(readOutput(snapshot.execution.value), 2);
  assert.deepEqual(
    snapshot.rootCall.value.processes.map((process) => process.sequence),
    [1, 2],
  );
  assert.deepEqual(
    snapshot.rootCall.value.processes.map((process) => process.eventSequence),
    [2, 7],
  );
  const appended = changes.take().filter((event) => event.change.kind === 'relation-appended');
  assert.equal(appended.length, 4);
  assert.ok(appended.every((event) => event.change.id === snapshot.rootCall.id));
});

test('record relation snapshots reject acceptance before return and duplicate event sequence', () => {
  const { recorder, execution } = completedPair();
  const snapshot = CallableRecordHelper.snapshot(recorder, execution.call.record.id);
  const invalid = structuredClone(snapshot);
  invalid.rootCall.value.relationChanges.splice(1, 1);
  assert.throws(() => validateExecutionRecordSnapshot(invalid));
  const duplicate = structuredClone(snapshot);
  duplicate.rootCall.value.relationChanges[0].eventSequence = duplicate.rootCall.value.processes[0].eventSequence;
  assert.throws(() => validateExecutionRecordSnapshot(duplicate));
});

test('execution snapshots require their actual Runtime call and its independent boundary facts', () => {
  const { recorder, execution } = completedPair();
  const snapshot = CallableRecordHelper.snapshot(recorder, execution.call.record.id);
  for (const field of ['rootCall', 'boundaries']) {
    const missing = structuredClone(snapshot);
    delete missing[field];
    assert.throws(() => validateExecutionRecordSnapshot(missing));
  }
  const unrelated = structuredClone(snapshot);
  unrelated.execution.parentId = 'another-runtime-call';
  assert.throws(() => validateExecutionRecordSnapshot(unrelated));
  const wrongScope = structuredClone(snapshot);
  wrongScope.boundaries[0].scopeId = snapshot.execution.id;
  assert.throws(() => validateExecutionRecordSnapshot(wrongScope));
});

test('preconstructed child attachments retain their fact order when the parent recording starts', () => {
  const { create, recorder } = fixture();
  const parent = create('scene', 'r', undefined, { id: 'runtime' });
  const child = create('group', 'e', parent.call);
  const relation = { parentContextId: 'r', childContextId: 'e', parentRound: 0, key: 'prepared' };
  parent.publish({ kind: 'relation', relation, change: { kind: 'attached' } }, 1);
  assert.equal(parent.call.record, undefined);
  relation.key = 'mutated after publication';
  parent.publish({ kind: 'started', input: null }, 10);
  const attached = parent.call.record.value.relationChanges[0];
  assert.equal(attached.eventSequence, 1);
  assert.equal(attached.identity.key, 'prepared');
  assert.equal(attached.offsetMs, 0);
  child.publish({ kind: 'started', input: null }, 12);
  child.publish({ kind: 'finished', state: { status: 'succeeded', output: 'done' } }, 13);
  parent.publish({ kind: 'relation', relation: { ...relation, key: 'prepared' }, change: { kind: 'returned', result: { status: 'succeeded', output: 'done' } } }, 14);
  parent.publish({ kind: 'finished', state: { status: 'succeeded', output: 'done' } }, 15);
  validateExecutionRecordSnapshot(CallableRecordHelper.snapshot(recorder, child.call.record.id));
});

test('record installation supplies a scoped writer, not an automatic second call-record path', () => {
  const { recording } = fixture();
  const scope = recording.bindInvocation({ identity: { kind: 'scene', contextId: 'r' }, description: { id: 'runtime' }, resources: new ResourceBindings({}), declarations: [invocationRecording()] });
  const fact = { kind: 'started', input: null, identity: scope.setup.identity, description: scope.setup.description, eventSequence: 1, occurredAt: '2026-10-09T00:00:00.000Z', monotonicTime: 0 };
  scope.observe(fact);
  assert.equal(scope.record, undefined);
  let writer;
  const declaration = defineObservation(
    {
      deps: { writer: InvocationRecordAccess.request() },
      observe(event, ports) {
        writer = ports.writer;
        writer.observe(event);
      },
    },
    { failure: 'propagate' },
  );
  const observation = bindInvocationObservation({ ...scope.setup, resources: scope.resources, declarations: [declaration] }, []);
  assert.equal(observation.publish(fact), undefined);
  assert.ok(scope.record);
  assert.throws(() => writer.observe(fact), ResourceAccessClosed);
});

test('failed scoped recording disables dependent children while later calls retain independent state', () => {
  const failures = [];
  const { create, recording } = fixture({ invalidate: (error) => failures.push(error) });
  const broken = create('scene', 'broken', undefined, { id: 'runtime' });
  assert.throws(() => broken.publish({ kind: 'started', input: () => {} }, 1));
  assert.equal(broken.call.available(), false);
  const child = create('group', 'child', broken.call);
  assert.equal(child.call.available(), false);
  child.publish({ kind: 'started', input: null }, 2);
  assert.equal(child.call.record, undefined);
  const good = create('scene', 'good', undefined, { id: 'runtime' });
  good.publish({ kind: 'started', input: null }, 3);
  assert.equal(good.call.available(), true);
  assert.ok(good.call.record);
  assert.equal(failures.length, 1);
  assert.equal(recording.root.childIds.length, 1);
});
