import type { CallableKind } from '../callable/kind.js';
import type { CheckpointCodec } from './codec.js';
import type { CheckpointReferenceSlots, CheckpointWriteReferences, CheckpointSelection } from './references.js';
import type { ChildContract } from '../children/contract.js';
import type { ChildReference } from '../children/reference.js';

declare const checkpointOwner: unique symbol;
/** A type witness; registration and exact point identity are independently checked at binding. */
export interface CheckpointPointOwner<Kind extends CallableKind, Input, Output, Delta> {
  readonly [checkpointOwner]?: (owner: { readonly kind: Kind; readonly input: Input; readonly output: Output }) => { readonly kind: Kind; readonly input: Input; readonly output: Output; readonly delta: Delta };
}

export interface AuthorCheckpointWriter<Kind extends CallableKind, Input, Output, Delta = never> {
  <Point extends CheckpointPointOwner<Kind, Input, Output, Delta> & { readonly state: CheckpointCodec<any>; readonly references: CheckpointReferenceSlots }>(options: { readonly point: Point; readonly state: NoInfer<ReturnType<Point['state']['decode']>> } & (keyof Point['references'] extends never ? { readonly refs?: NoInfer<CheckpointWriteReferences<Point['references']>> } : { readonly refs: NoInfer<CheckpointWriteReferences<Point['references']>> })): void;
  /** Initial arrays import once; an authentic saved many slot resumes its stored selection. */
  select<Definition extends ChildContract>(definition: Kind extends 'node' ? never : Definition, initial?: readonly ChildReference<NoInfer<Definition>>[]): CheckpointSelection<Definition>;
}
