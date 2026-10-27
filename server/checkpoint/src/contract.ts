import type { InvocationIdentity, InvocationFailureFact, CheckpointValue, CheckpointContract } from '@capix/contracts';

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

/** A failed delivery stays failed after its parent explicitly adopts a replacement value. */
export interface CheckpointHandledReception {
  readonly kind: 'handled';
  readonly contract?: CheckpointReceptionContract;
  readonly output?: CheckpointValue;
}

export interface CheckpointChild {
  readonly identity: InvocationIdentity;
  readonly target: { readonly position: number };
  readonly contract?: CheckpointContract;
  readonly round: number;
  readonly order: number;
  readonly key?: string;
  readonly input: CheckpointValue;
  readonly state: { readonly kind: 'waiting' } | { readonly kind: 'returned'; readonly output: CheckpointValue; readonly progress: { readonly round: number; readonly currentInput: CheckpointValue; readonly phase: 'execute' | 'receive' | 'handling' }; readonly reception: CheckpointChildReception } | { readonly kind: 'failed'; readonly error: CheckpointValue; readonly failure: InvocationFailureFact; readonly progress: { readonly round: number; readonly currentInput: CheckpointValue; readonly phase: 'execute' | 'receive' | 'handling' }; readonly reception?: CheckpointHandledReception };
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
  readonly formatVersion: 5;
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
