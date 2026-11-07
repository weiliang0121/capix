import type { ChildContract } from '../children/contract.js';
import type { ChildReference } from '../children/reference.js';
import type { ChildFact } from '../children/facts.js';

export interface ChildReferenceSlot<Definition extends ChildContract = ChildContract, Many extends boolean = boolean> {
  readonly definition: Definition;
  readonly many: Many;
}
export type CheckpointReferenceSlots = Readonly<Record<string, ChildReferenceSlot>>;

declare const occurrenceDefinition: unique symbol;
declare const selectionDefinition: unique symbol;

/** One appearance in one invocation-owned ordered selection, not the child itself. */
export interface CheckpointOccurrence<Definition extends ChildContract = ChildContract> {
  readonly [occurrenceDefinition]: Definition;
}

/** Mutable selection operations; the selected child references and facts remain unchanged. */
export interface CheckpointSelection<Definition extends ChildContract = ChildContract> extends Iterable<ChildReference<Definition>> {
  readonly [selectionDefinition]: Definition;
  readonly length: number;
  at(index: number): ChildReference<Definition> | undefined;
  occurrenceAt(index: number): CheckpointOccurrence<Definition> | undefined;
  add(reference: ChildReference<Definition>): CheckpointOccurrence<Definition>;
  remove(occurrence: CheckpointOccurrence<Definition>): void;
}

export type SavedReferences<Slots extends CheckpointReferenceSlots> = { readonly [Key in keyof Slots]: Slots[Key] extends ChildReferenceSlot<infer Definition, infer Many> ? (Many extends true ? readonly ChildReference<Definition>[] : ChildReference<Definition>) : never };
/** Arrays replace the complete slot; a selection explicitly supplies its current revision. */
export type CheckpointWriteReferences<Slots extends CheckpointReferenceSlots> = { readonly [Key in keyof Slots]: Slots[Key] extends ChildReferenceSlot<infer Definition, infer Many> ? (Many extends true ? readonly ChildReference<Definition>[] | CheckpointSelection<Definition> : ChildReference<Definition>) : never };
export type SavedReferenceFacts<Slots extends CheckpointReferenceSlots> = { readonly [Key in keyof Slots]: Slots[Key] extends ChildReferenceSlot<infer Definition, infer Many> ? (Many extends true ? readonly ChildFact<Definition>[] : ChildFact<Definition>) : never };
