import type { CallableKind } from '../callable/kind.js';
import type { CheckpointCodec } from './codec.js';
import type { CheckpointReferenceSlots, SavedReferences } from './references.js';

declare const checkpointOwner: unique symbol;
/** A type witness; registration and exact point identity are independently checked at binding. */
export interface CheckpointPointOwner<Kind extends CallableKind, Input, Output, Delta> {
  readonly [checkpointOwner]?: (owner: { readonly kind: Kind; readonly input: Input; readonly output: Output }) => { readonly kind: Kind; readonly input: Input; readonly output: Output; readonly delta: Delta };
}

export interface AuthorCheckpointWriter<Kind extends CallableKind, Input, Output, Delta = never> {
  <Point extends CheckpointPointOwner<Kind, Input, Output, Delta> & { readonly state: CheckpointCodec<any>; readonly references: CheckpointReferenceSlots }>(options: { readonly point: Point; readonly state: NoInfer<ReturnType<Point['state']['decode']>> } & (keyof Point['references'] extends never ? { readonly refs?: NoInfer<SavedReferences<Point['references']>> } : { readonly refs: NoInfer<SavedReferences<Point['references']>> })): void;
}
