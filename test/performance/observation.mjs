// Run after build + app test compilation: node test/performance/observation.mjs
// Synthetic wire facts only; no provider, server or real model is invoked.
import { performance } from 'node:perf_hooks';
import { ObservationReplica } from '@capix/client-runtime';
import { createObservationProjection } from '../../apps/observer/.test-dist/binding/observation.js';
import { baseline, entriesOf, snapshot } from '../client/fixtures.mjs';

export function observationFixture(rounds = 200, batches = 40) {
  const values = Array.from({ length: rounds }, (_, index) => snapshot('running', `execution-${index}`));
  const initial = baseline({ entries: values.flatMap(entriesOf) });
  const target = values.at(-1).execution;
  const frames = Array.from({ length: batches }, (_, index) => ({ type: 'delta', scopeId: initial.scopeId, sequence: index + 1, changes: [{ type: 'record', recorderId: initial.recorder.id, revision: index + 1, occurredAt: target.value.startedAt, change: { kind: 'replaced', entry: { kind: 'execution', data: { ...target, value: { ...target.value, input: { round: index } } } } } }] }));
  return { initial, frames };
}

export function observationState(replica) {
  return { enabled: true, loading: false, records: replica.snapshots, updates: replica.snapshots, overview: replica.overview, memory: replica.memory, transcriptRecords: replica.transcriptRecords };
}

function measure(rounds, batches) {
  const fixture = observationFixture(rounds, batches);
  let replica = ObservationReplica.receive(undefined, fixture.initial);
  const project = createObservationProjection();
  const transcripts = new Map();
  let view = project(observationState(replica), transcripts);
  let receiverMs = 0;
  let bindingMs = 0;
  let rebuiltSnapshots = 0;
  let rebuiltRounds = 0;
  for (const frame of fixture.frames) {
    const start = performance.now();
    const next = ObservationReplica.receive(replica, frame);
    const received = performance.now();
    const nextView = project(observationState(next), transcripts);
    const projected = performance.now();
    receiverMs += received - start;
    bindingMs += projected - received;
    for (const [id, value] of next.snapshots) if (replica.snapshots.get(id) !== value) rebuiltSnapshots++;
    for (let index = 0; index < nextView.rounds.length; index++) if (view.rounds[index] !== nextView.rounds[index]) rebuiltRounds++;
    replica = next;
    view = nextView;
  }
  return { rounds, batches, rebuiltSnapshots, rebuiltRounds, receiverMs: Math.round(receiverMs), bindingMs: Math.round(bindingMs) };
}

if (process.argv[1]?.endsWith('/performance/observation.mjs')) {
  measure(10, 5);
  console.log(JSON.stringify(measure(200, 40)));
}
