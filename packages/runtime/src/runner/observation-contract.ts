import type { InvocationIdentity } from '@weiliang0121/capix-contracts';
import type { InvocationProgress } from '@weiliang0121/capix-invocation';

/** Bounded explanation only; never retains a thrown object or its attached business data. */
export interface RunnerDiagnostic {
  readonly code: string;
  readonly message: string;
}

/** Sequence belongs to this entry request, including failures before any call exists. */
export type RunnerEntryFact = Readonly<{ sequence: number; occurredAt: string } & ({ kind: 'requested'; mode: 'run' | 'resume'; requestedContextId?: string } | { kind: 'acquired' | 'released' } | { kind: 'rejected'; reason: 'busy'; diagnostic: RunnerDiagnostic } | { kind: 'entry-failed'; diagnostic: RunnerDiagnostic } | { kind: 'attached'; identity: InvocationIdentity } | { kind: 'settled'; status: 'succeeded' | 'failed' | 'cancelled'; diagnostic?: RunnerDiagnostic })>;

/** Resource operations retain their own source order; descriptions are not evaluated here. */
export interface RunnerResourceFact {
  readonly contextId: string;
  readonly offerId: string;
  readonly access: string;
  readonly supplyId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: 'bound' | 'available' | 'unavailable' | 'started' | 'returned' | 'threw';
  readonly interactionId?: string;
}

export interface RunnerBusinessFact {
  readonly identity: InvocationIdentity;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly event: string;
}

export type RunnerCheckpointChild = Readonly<{ identity: InvocationIdentity; round: number; order: number; key?: string } & ({ state: 'waiting' } | { state: 'returned'; reception: 'pending' | 'receiving' | 'accepted' | 'failed' } | { state: 'failed'; reception?: 'handled' })>;

export interface RunnerTranscriptFact {
  readonly transcriptId: string;
  readonly revision: number;
  readonly change: 'messages-appended' | 'segment-started';
  readonly start: number;
  readonly end: number;
}

export interface RunnerMemoryFact {
  readonly memoriesId: string;
  readonly sequence: number;
  readonly action: 'create' | 'update';
  readonly memoryId: string;
}

/** Installed is a historical baseline; sequence orders this activity, not the restored call's past. */
export type RunnerCheckpointFact = Readonly<{ activityId: string; contextId: string; owner: InvocationIdentity; recovering: boolean; sequence: number; occurredAt: string } & ({ kind: 'captured' | 'saved' | 'checking' | 'continued'; checkpointId: string; point: string } | { kind: 'installed'; checkpointId: string; point: string; baseline: Readonly<{ round: number; nextChildOrder: number; childCount: number }> } | { kind: 'child-restored'; child: RunnerCheckpointChild; mode: 'continuation' | 'delivery' } | { kind: 'activity'; fact: InvocationProgress } | { kind: 'resource'; fact: RunnerResourceFact } | { kind: 'transcript'; fact: RunnerTranscriptFact } | { kind: 'memory'; fact: RunnerMemoryFact } | { kind: 'failed'; stage: 'capture' | 'save' | 'restore' | 'finish'; diagnostic: RunnerDiagnostic; childContextId?: string } | { kind: 'finishing' | 'finished'; status: 'succeeded' | 'failed' | 'cancelled' })>;

/** Each producer keeps its own identity and order; entryId only correlates one Runner request. */
export type RunnerObservationEvent = Readonly<{ runnerId: string; entryId: string } & ({ source: 'entry'; fact: RunnerEntryFact } | { source: 'invocation'; fact: InvocationProgress } | { source: 'resource'; fact: RunnerResourceFact } | { source: 'checkpoint'; fact: RunnerCheckpointFact } | { source: 'business'; fact: RunnerBusinessFact })>;
