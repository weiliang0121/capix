import type { InvocationIdentity } from '@capix/contracts';
import type { ProgressReceiver } from '@capix/changes';
import type { CheckpointChild, CheckpointDelivery, CheckpointHead, CheckpointImage, CheckpointSaveReceipt, CheckpointReference, CheckpointStore, InvocationCheckpointFrame } from '@capix/checkpoint';

export type CheckpointFact = Readonly<
  {
    activityId: string;
    contextId: string;
    owner: InvocationIdentity;
    recovering: boolean;
    sequence: number;
    occurredAt: string;
  } & ({ kind: 'captured' | 'saved'; checkpointId: string; point: string } | { kind: 'checking' | 'continued'; checkpointId: string; point: string } | { kind: 'installed'; checkpointId: string; point: string; frame: InvocationCheckpointFrame } | { kind: 'child-restored'; child: CheckpointChild; mode: 'continuation' | 'delivery' } | { kind: 'activity'; fact: import('../observation/facts.js').InvocationFact } | { kind: 'resource'; fact: import('../observation/facts.js').ResourceObservation } | { kind: 'transcript'; fact: import('@capix/protocol').TranscriptEvent } | { kind: 'memory'; fact: import('@capix/protocol').MemoryEvent } | { kind: 'failed'; stage: 'capture' | 'save' | 'restore' | 'finish'; error: unknown; childContextId?: string } | { kind: 'finishing' | 'finished'; status: CheckpointDelivery['status'] })
>;

export interface CheckpointInstallation {
  readonly store: CheckpointStore;
  readonly observation?: { observe(fact: CheckpointFact): void; readonly failure?: 'isolate' | 'propagate' };
  /** Passive delivery of the same facts; consumer failure never changes checkpoint execution. */
  readonly feedback?: ProgressReceiver<CheckpointFact>;
}

export interface CheckpointWriter {
  select(position: number, initial?: readonly CheckpointReference[]): InvocationCheckpointSelection;
  save(point: string, state: unknown, references?: CheckpointSaveReferences): CheckpointSaveReceipt;
}

declare const occurrence: unique symbol;
/** One occurrence, including repeated selections of the same child. Never a child identity. */
export interface InvocationCheckpointOccurrence {
  readonly [occurrence]: true;
}

/** An invocation-owned ordered selection; removing an occurrence never removes its relation. */
export interface InvocationCheckpointSelection extends Iterable<CheckpointReference> {
  readonly length: number;
  at(index: number): CheckpointReference | undefined;
  occurrenceAt(index: number): InvocationCheckpointOccurrence | undefined;
  add(reference: CheckpointReference): InvocationCheckpointOccurrence;
  remove(occurrence: InvocationCheckpointOccurrence): void;
}

export type CheckpointSaveReferences = Readonly<Record<string, CheckpointReference | readonly CheckpointReference[] | InvocationCheckpointSelection>>;

/** Internal construction data; never accepted from a business invocation view. */
export interface CheckpointRestoration {
  readonly head: CheckpointHead;
}
