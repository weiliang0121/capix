import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Runner, Resources, Scene, Node, bindRecording, invocationRecording } from '@weiliang0121/capix-runtime';
import { Recorder, RecordBook, CallableRecord } from '@weiliang0121/capix-records';
import { validateInvocationRecordValue } from '@weiliang0121/capix-protocol';
import { ClientSubmission, SubmissionContractError, ObservationConnectionError } from '@capix/client-runtime';
import { ConversationHttpTransport, ObservationHttpTransport } from '@capix/client-http';
import { submissionSnapshot } from './client/fixtures.mjs';
import { projectCallGraph } from '../apps/observer/.test-dist/binding/graph.js';
import { projectConversationProcess } from '../apps/observer/.test-dist/binding/activities.js';

async function recordedHandling() {
  const recorder = new Recorder(new RecordBook());
  const failure = new Error('missing source');
  const result = { text: 'fallback', omitted: 'private' };
  const node = new Node({
    run() {
      throw failure;
    },
  });
  const scene = new Scene({
    run(work) {
      return work.children.invoke(node, null, {
        result: {
          failed(error) {
            assert.equal(error, failure);
            return result;
          },
        },
      });
    },
  }).add(node);
  const recording = bindRecording(recorder, { failure: 'propagate' });
  recording.describe(scene, { output: (output) => output.text, relationHandled: (output) => ({ text: output.text }) });
  const runner = new Runner(scene, new Resources(), undefined, { observations: [recording] }).build();
  const delivered = await runner.run(null);
  assert.deepEqual(delivered, result);
  assert.notEqual(delivered, result);
  assert.equal(Object.isFrozen(delivered), true);
  result.text = 'changed';
  assert.equal(delivered.text, 'fallback');
  const records = [...recorder.book.values()].filter((record) => record instanceof CallableRecord);
  return { parent: records.find((record) => record.structureKind === 'scene'), child: records.find((record) => record.structureKind === 'node') };
}

test('real failed child delivery produces handled parent facts and preserves failed child records', async () => {
  const { parent, child } = await recordedHandling();
  assert.equal(parent.status, 'succeeded');
  assert.equal(child.status, 'failed');
  assert.deepEqual(
    parent.value.relationChanges.map((entry) => entry.change.kind),
    ['attached', 'returned', 'receiving', 'handled'],
  );
  assert.equal(parent.value.relationChanges[1].change.result.status, 'failed');
  assert.deepEqual(parent.value.relationChanges.at(-1).change.output, { text: 'fallback' });
  validateInvocationRecordValue(parent.value, parent.contextId);
  validateInvocationRecordValue(child.value, child.contextId);
  const forged = structuredClone(parent.value);
  forged.relationChanges.at(-1).change.kind = 'accepted';
  assert.throws(() => validateInvocationRecordValue(forged, parent.contextId));
  const successAsHandled = structuredClone(parent.value);
  successAsHandled.relationChanges[1].change.result = { status: 'succeeded', output: 'original' };
  assert.throws(() => validateInvocationRecordValue(successAsHandled, parent.contextId));
});

const startedAt = '2026-10-25T00:00:00.000Z';
const finishedAt = '2026-10-25T00:00:01.000Z';
const input = { messages: [{ role: 'user', content: 'question' }] };
const activityRoot = { contextId: 'root', kind: 'scene', label: '处理', status: 'running', phase: 'execute', round: 1, startedAt };
const activityChild = (phase, returned = 'failed') => ({ contextId: 'child', parentContextId: 'root', kind: 'node', label: '读取', status: 'failed', phase: 'execute', round: 1, startedAt, finishedAt, relation: { phase, returned } });
const activities = (phase, returned) => ({ calls: [activityRoot, activityChild(phase, returned)], integrity: { status: 'complete' } });

test('activity consumption accepts failed return then reception then handled without rewriting call status', () => {
  const submission = new ClientSubmission('fixture-conversation', input);
  for (const [index, phase] of ['returned', 'receiving', 'handled'].entries()) {
    submission.receive(submissionSnapshot(submission.id, { revision: index + 1, activities: activities(phase) }));
  }
  assert.equal(submission.snapshot.remote.activities.calls[1].status, 'failed');
  assert.equal(submission.snapshot.remote.activities.calls[1].relation.phase, 'handled');
  const retained = submission.snapshot;
  assert.throws(() => submission.receive(submissionSnapshot(submission.id, { revision: 4, activities: activities('accepted') })), SubmissionContractError);
  assert.equal(submission.snapshot, retained);
  for (const [phase, returned] of [
    ['handled', 'succeeded'],
    ['handled', 'cancelled'],
    ['accepted', 'failed'],
    ['receiving', 'cancelled'],
  ]) {
    const fresh = new ClientSubmission('fixture-conversation', input);
    assert.throws(() => fresh.receive(submissionSnapshot(fresh.id, { revision: 1, activities: activities(phase, returned) })), SubmissionContractError);
  }
});

test('HTTP transports preserve handled activity and actual handled record changes', async () => {
  const { parent } = await recordedHandling();
  const body = { type: 'baseline', submission: submissionSnapshot('submission', { activities: activities('handled') }) };
  const conversation = new ConversationHttpTransport('', async () => Response.json(body));
  assert.equal((await conversation.read('submission')).submission.activities.calls[1].relation.phase, 'handled');
  for (const [phase, returned] of [
    ['handled', 'succeeded'],
    ['handled', 'cancelled'],
    ['accepted', 'failed'],
    ['receiving', 'cancelled'],
  ]) {
    const invalid = { ...body, submission: { ...body.submission, activities: activities(phase, returned) } };
    const invalidTransport = new ConversationHttpTransport('', async () => Response.json(invalid));
    await assert.rejects(invalidTransport.read('submission'), (error) => error.kind === 'contract');
  }
  const frame = {
    type: 'delta',
    scopeId: 'scope',
    sequence: 1,
    changes: [
      { type: 'record', recorderId: 'records', revision: 1, occurredAt: startedAt, change: { kind: 'relation-appended', id: parent.id, relation: parent.value.relationChanges.at(-1) } },
      { type: 'invocation', contextId: parent.contextId, kind: 'scene', sequence: 1, occurredAt: startedAt, change: { kind: 'relation', identity: parent.value.relationChanges.at(-1).identity, phase: 'handled' } },
    ],
  };
  const observation = new ObservationHttpTransport('', async () => new Response(`${JSON.stringify(frame)}\n`));
  const received = [];
  await assert.rejects(
    observation.observe('fixture-conversation', (value) => received.push(value), new AbortController().signal),
    ObservationConnectionError,
  );
  assert.equal(received[0].changes[0].change.relation.change.kind, 'handled');
  assert.equal(received[0].changes[1].change.phase, 'handled');
});

test('handled UI explains the parent result while retaining failed child appearance', async () => {
  const { parent, child } = await recordedHandling();
  const call = (record) => ({ id: record.id, contextId: record.contextId, parentId: record === parent ? undefined : parent.id, recordType: record.structureKind, label: record === parent ? '处理' : '读取', status: record.status, offsetMs: 0, durationMs: 1 });
  const calls = [call(parent), call(child)];
  const detail = { id: parent.id, calls: new Map(calls.map((value) => [value.id, { ...value, status: value.status === 'succeeded' ? 'passed' : value.status, processes: [], resources: [], memory: { incoming: [], changes: [] }, relationEntries: value.id === parent.id ? parent.value.relationChanges : [], children: [] }])) };
  const graph = projectCallGraph({ id: parent.id, calls }, detail);
  assert.equal(graph.roots[0].children[0].status, 'failed');
  assert.equal(graph.roots[0].children[0].reception.label, '失败已处理');
  const process = projectConversationProcess({ id: 'submission', feedback: { status: 'following' }, remote: submissionSnapshot('submission', { activities: activities('handled') }) });
  assert.equal(process.label, '正在处理');
});
