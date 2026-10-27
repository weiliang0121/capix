import type { InvocationIdentity } from '@capix/contracts';
import type { CheckpointChild, CheckpointDelivery, CheckpointHead, CheckpointImage, CheckpointReferences, CheckpointStore, InvocationCheckpointFrame } from '@capix/checkpoint';

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
}

export interface CheckpointWriter {
  save(point: string, state: unknown, references?: CheckpointReferences): CheckpointImage;
}

/** Internal construction data; never accepted from a business invocation view. */
export interface CheckpointRestoration {
  readonly head: CheckpointHead;
}
