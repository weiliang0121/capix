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
  readonly formatVersion: 6;
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
  /** Serializable v6 publication references, authenticated against the complete image on cold read. */
  readonly publication?: CheckpointPublication;
}

/** A write acknowledgement, not a second read of the complete recovery image. */
export interface CheckpointSaveReceipt {
  readonly kind: 'saved';
  readonly contextId: string;
  readonly checkpointId: string;
  readonly revision: number;
  readonly digest: string;
}

export interface CheckpointFinishReceipt {
  readonly kind: 'finished';
  readonly contextId: string;
  readonly checkpointId: string;
  readonly revision: number;
  readonly status: CheckpointDelivery['status'];
  readonly digest: string;
}

/** Synchronous durable boundary, independent of records and optional observation. */
export interface CheckpointStore {
  read(contextId: string): CheckpointHead | undefined;
  save(image: CheckpointImage | CheckpointCommit, expectedRevision: number): CheckpointSaveReceipt;
  finish(contextId: string, expectedRevision: number, delivery: CheckpointDelivery): CheckpointFinishReceipt;
}

/** A value is published inside one owning checkpoint scope, never by digest alone. */
export interface CheckpointValueReference {
  readonly id: string;
  readonly digest: string;
}

export interface CheckpointValueBlock extends CheckpointValueReference {
  readonly value: CheckpointValue;
}

type ReferencedProgress = { readonly round: number; readonly currentInput: CheckpointValueReference; readonly phase: 'execute' | 'receive' | 'handling' };
type ReferencedReception = { readonly kind: 'pending' } | { readonly kind: 'receiving'; readonly contract?: CheckpointReceptionContract } | { readonly kind: 'accepted'; readonly contract?: CheckpointReceptionContract; readonly output?: CheckpointValueReference } | { readonly kind: 'failed'; readonly contract?: CheckpointReceptionContract; readonly error: CheckpointValueReference; readonly failure: InvocationFailureFact & { readonly kind: 'exception'; readonly contract: string } };

/** Only changed current relations are submitted. Fixed large fields are value references. */
export interface CheckpointChildRecord extends Omit<CheckpointChild, 'input' | 'state'> {
  readonly input: CheckpointValueReference;
  readonly state: { readonly kind: 'waiting' } | { readonly kind: 'returned'; readonly output: CheckpointValueReference; readonly progress: ReferencedProgress; readonly reception: ReferencedReception } | { readonly kind: 'failed'; readonly error: CheckpointValueReference; readonly failure: InvocationFailureFact; readonly progress: ReferencedProgress; readonly reception?: { readonly kind: 'handled'; readonly contract?: CheckpointReceptionContract; readonly output?: CheckpointValueReference } };
}

/** Incremental physical write; read() still returns the fully authenticated logical image. */
export interface CheckpointCommit {
  readonly kind: 'commit';
  readonly formatVersion: 6;
  readonly id: string;
  readonly contract: CheckpointContract;
  readonly point: string;
  readonly frame: Omit<InvocationCheckpointFrame, 'input' | 'currentInput' | 'children'> & { readonly input: CheckpointValueReference; readonly currentInput: CheckpointValueReference };
  readonly state: CheckpointValueReference;
  readonly references: CheckpointValueReference | CheckpointSelectionSlots;
  readonly selectionChanges?: readonly CheckpointSelectionChange[];
  readonly values: readonly CheckpointValueBlock[];
  readonly children: readonly CheckpointChildRecord[];
}

/** One ordered selection belongs to an invocation and one fixed child position. */
export interface CheckpointSelectionReference {
  readonly id: string;
  readonly revision: number;
  readonly target: { readonly position: number };
}

export interface CheckpointSelectionSlots {
  readonly kind: 'slots';
  readonly slots: Readonly<Record<string, { readonly kind: 'one'; readonly reference: CheckpointReference } | { readonly kind: 'many'; readonly selection: CheckpointSelectionReference }>>;
}

export interface CheckpointSelectionChange {
  readonly id: string;
  readonly target: { readonly position: number };
  readonly expectedRevision: number;
  /** Explicit complete replacement. Old occurrence identities remain reserved. */
  readonly reset?: true;
  readonly append?: readonly { readonly id: string; readonly reference: CheckpointReference }[];
  readonly remove?: readonly { readonly id: string; readonly order: number; readonly reference: CheckpointReference }[];
}

/** Cold-only evidence for the selections explicitly named by the saved point. */
export interface CheckpointSelectionSnapshot extends CheckpointSelectionReference {
  readonly owner: string;
  readonly nextOrder: number;
  readonly count: number;
  readonly bytes: number;
  readonly nodes: number;
  readonly sum: string;
  readonly digest: string;
  readonly occurrences: readonly { readonly id: string; readonly order: number; readonly reference: CheckpointReference }[];
}

export interface CheckpointPublication extends CheckpointCommit {
  readonly selectedSelections?: readonly CheckpointSelectionSnapshot[];
}
