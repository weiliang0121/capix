import type { InvocationIdentity } from '../invocation/identity.js';
import type { InvocationFailureFact } from '@capix/protocol';

export type CheckpointValue = null | boolean | number | string | readonly CheckpointValue[] | { readonly [key: string]: CheckpointValue };

/** Encoding is explicit; decoders must reject incompatible saved business values. */
export interface CheckpointCodec<Value> {
  encode(value: Value): CheckpointValue;
  decode(value: CheckpointValue): Value;
}

export interface CheckpointContract {
  readonly key: string;
  readonly version: number;
}

/** Persistent association is scoped by the owning checkpoint contract/version. */
export interface CheckpointReference {
  readonly contextId: string;
  readonly parentContextId: string;
  readonly parentRound: number;
  readonly order: number;
  readonly target: { readonly position: number };
}

export type CheckpointReferences = Readonly<Record<string, CheckpointReference | readonly CheckpointReference[]>>;

export interface CheckpointContinuation {
  readonly fromRound: 1;
  readonly stage: 'accept' | 'handling';
  readonly reason: string;
  readonly origin?: { readonly kind: 'self'; readonly phase: 'execute' | 'accept' } | { readonly kind: 'child-return' | 'child-reception'; readonly child: CheckpointReference };
}

export interface CheckpointReceptionContract {
  readonly position: number;
}

export type CheckpointChildReception = { readonly kind: 'pending' } | { readonly kind: 'receiving'; readonly contract?: CheckpointReceptionContract } | { readonly kind: 'accepted'; readonly contract?: CheckpointReceptionContract; readonly output?: CheckpointValue } | { readonly kind: 'failed'; readonly contract?: CheckpointReceptionContract; readonly error: CheckpointValue; readonly failure: InvocationFailureFact & { readonly kind: 'exception'; readonly contract: string } };

export interface CheckpointChild {
  readonly identity: InvocationIdentity;
  readonly target: { readonly position: number };
  readonly contract?: CheckpointContract;
  readonly round: number;
  readonly order: number;
  readonly key?: string;
  readonly input: CheckpointValue;
  readonly state: { readonly kind: 'waiting' } | { readonly kind: 'returned'; readonly output: CheckpointValue; readonly progress: { readonly round: number; readonly currentInput: CheckpointValue; readonly phase: 'execute' | 'receive' | 'handling' }; readonly reception: CheckpointChildReception } | { readonly kind: 'failed'; readonly error: CheckpointValue; readonly failure: InvocationFailureFact & { readonly kind: 'exception'; readonly contract: string }; readonly progress: { readonly round: number; readonly currentInput: CheckpointValue; readonly phase: 'execute' | 'receive' | 'handling' } };
}

export interface InvocationCheckpointFrame {
  readonly owner: InvocationIdentity;
  readonly round: number;
  readonly phase: 'execute';
  readonly input: CheckpointValue;
  readonly currentInput: CheckpointValue;
  readonly nextChildOrder: number;
  readonly children: readonly CheckpointChild[];
  readonly continuation?: CheckpointContinuation;
}

export interface CheckpointImage {
  readonly id: string;
  readonly formatVersion: 4;
  readonly contract: CheckpointContract;
  readonly point: string;
  readonly frame: InvocationCheckpointFrame;
  readonly state: CheckpointValue;
  readonly references: CheckpointReferences;
}

export type CheckpointDelivery = { readonly status: 'succeeded'; readonly output: CheckpointValue; readonly progress: { readonly round: number; readonly currentInput: CheckpointValue; readonly phase: 'execute' | 'receive' | 'handling' } } | { readonly status: 'failed' | 'cancelled' };

/** The latest image and final delivery are separate; execute output is not final delivery. */
export interface CheckpointHead {
  readonly revision: number;
  readonly image: CheckpointImage;
  readonly delivery?: CheckpointDelivery;
}

/** Synchronous durable boundary, independent of records and optional observation. */
export interface CheckpointStore {
  read(contextId: string): CheckpointHead | undefined;
  save(image: CheckpointImage, expectedRevision: number): CheckpointHead;
  finish(contextId: string, expectedRevision: number, delivery: CheckpointDelivery): CheckpointHead;
}

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
