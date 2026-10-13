import test from 'node:test';
import assert from 'node:assert/strict';
import { ObservationReplica, ObservationSequenceError } from '@capix/client-runtime';
import { baseline, entriesOf, snapshot } from '../client/fixtures.mjs';
import { observationFixture } from '../performance/observation.mjs';

function replace(replica, entries) {
  return { type: 'delta', scopeId: replica.scopeId, sequence: replica.sequence + 1, changes: entries.map((entry, index) => ({ type: 'record', recorderId: replica.recorder.id, revision: replica.recorder.revision + index + 1, occurredAt: '2026-10-13T00:00:00Z', change: { kind: 'replaced', entry } })) };
}

test('long conversation updates preserve every unrelated complete execution snapshot', () => {
  const fixture = observationFixture();
  let replica = ObservationReplica.receive(undefined, fixture.initial);
  const first = replica.snapshots.get('execution-0');
  for (const frame of fixture.frames) {
    const previous = replica;
    replica = ObservationReplica.receive(replica, frame);
    assert.equal(replica.updates.size, 1);
    assert.equal(replica.snapshots.get('execution-0'), first);
    assert.notEqual(replica.snapshots.get('execution-199'), previous.snapshots.get('execution-199'));
  }
  assert.equal(replica.snapshots.size, 200);
});

test('R-owned facts refresh every contained E, while an E fact refreshes only that E', () => {
  const first = snapshot('running', 'first');
  const second = snapshot('running', 'second');
  const unrelated = snapshot('running', 'unrelated');
  second.execution.parentId = first.runtimeCall.id;
  first.runtimeCall.childIds.push(second.execution.id);
  const entries = [...entriesOf(first), ...entriesOf(second).filter((entry) => entry.kind !== 'runtime-call' && entry.data.parentId !== second.runtimeCall.id), ...entriesOf(unrelated)];
  // The second E itself was reparented; its descendant boundaries still belong to it.
  if (!entries.some((entry) => entry.data.id === second.execution.id)) entries.push({ kind: 'execution', data: second.execution });
  let replica = ObservationReplica.receive(undefined, baseline({ entries }));
  assert.equal(replica.snapshots.size, 3);
  const original = replica;
  replica = ObservationReplica.receive(replica, replace(replica, [{ kind: 'runtime-call', data: { ...first.runtimeCall, value: { ...first.runtimeCall.value, input: 'new R input' } } }]));
  assert.deepEqual([...replica.updates.keys()].sort(), ['first', 'second']);
  assert.equal(replica.snapshots.get('unrelated'), original.snapshots.get('unrelated'));
  assert.equal(replica.snapshots.get('first').runtimeCall, replica.snapshots.get('second').runtimeCall);
  const previous = replica;
  replica = ObservationReplica.receive(replica, replace(replica, [{ kind: 'execution', data: { ...second.execution, value: { ...second.execution.value, input: 'new E input' } } }]));
  assert.deepEqual([...replica.updates.keys()], ['second']);
  assert.equal(replica.snapshots.get('first'), previous.snapshots.get('first'));
});

test('a rejected later change leaves the accepted snapshot map and earlier record values untouched', () => {
  const fixture = observationFixture(2, 1);
  const previous = ObservationReplica.receive(undefined, fixture.initial);
  const event = fixture.frames[0].changes[0];
  const originalEntry = previous.entries.get(event.change.entry.data.id);
  const invalid = { ...fixture.frames[0], changes: [event, event] };
  assert.throws(() => ObservationReplica.receive(previous, invalid), ObservationSequenceError);
  assert.equal(previous.entries.get(originalEntry.data.id), originalEntry);
  assert.equal(previous.sequence, 0);
  assert.equal(previous.snapshots.get('execution-1').execution, originalEntry.data);
});

test('non-record delivery advances source positions without rebuilding execution views', () => {
  const fixture = observationFixture(2, 1);
  const previous = ObservationReplica.receive(undefined, fixture.initial);
  const next = ObservationReplica.receive(previous, { type: 'delta', scopeId: previous.scopeId, sequence: 1, changes: [{ type: 'transcript', transcriptId: previous.transcript.id, revision: 1, occurredAt: '2026-10-13T00:00:00Z', change: { kind: 'messages-appended', start: 0, end: 1 } }] });
  assert.equal(next.snapshots, previous.snapshots);
  assert.equal(next.updates.size, 0);
  assert.equal(next.overview.messages.length, 1);
});

test('replacement cannot move a recorded E into a different R and bypass sibling validation', () => {
  const fixture = observationFixture(2, 1);
  const previous = ObservationReplica.receive(undefined, fixture.initial);
  const first = previous.entries.get('execution-0');
  const moved = { ...first, data: { ...first.data, parentId: 'runtime-call-execution-1' } };
  assert.throws(() => ObservationReplica.receive(previous, replace(previous, [moved])), /归属不能被替换/);
  assert.equal(previous.entries.get(first.data.id), first);
});
