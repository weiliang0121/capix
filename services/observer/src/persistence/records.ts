import type { RecordEntry, RecordMutation, InvocationValue, ProcessRecord, RelationChangeRecord } from '@weiliang0121/capix-protocol';

/** Apply the producer's declared mutation, never infer changes by comparing snapshots. */
export function updateRecord(entry: RecordEntry, mutation: Exclude<RecordMutation, { kind: 'added' | 'replaced' }>): RecordEntry {
  if (!['invocation', 'runtime-call', 'execution', 'operation', 'attempt'].includes(entry.kind)) throw new Error('Record mutation requires an invocation');
  const data = entry.data as RecordEntry['data'] & { status: string; value: InvocationValue };
  if (data.status !== 'running') throw new Error('A finished record cannot change');
  const value = data.value;
  if (mutation.kind === 'process-appended') {
    if (mutation.process.sequence !== value.processes.length + 1) throw new Error('Record process sequence mismatch');
    checkEventSequence(value, mutation.process);
    return { kind: entry.kind, data: { ...data, value: { ...value, processes: [...value.processes, mutation.process] } } };
  }
  if (mutation.kind === 'relation-appended') {
    checkEventSequence(value, mutation.relation);
    return { kind: entry.kind, data: { ...data, value: { ...value, relationChanges: [...value.relationChanges, mutation.relation] } } };
  }
  return { kind: entry.kind, data: { ...data, status: mutation.status, value: { ...value, ...mutation.result } } } as RecordEntry;
}

function checkEventSequence(value: InvocationValue, next: ProcessRecord | RelationChangeRecord): void {
  const previous = Math.max(value.processes.at(-1)?.eventSequence ?? 0, value.relationChanges.at(-1)?.eventSequence ?? 0);
  if (next.eventSequence <= previous) throw new Error('Record event sequence mismatch');
}
