import type { ChildContract } from '../children/contract.js';
import type { ChildReference } from '../children/reference.js';
import type { ChildFact } from '../children/facts.js';

export interface ChildReferenceSlot<Definition extends ChildContract = ChildContract, Many extends boolean = boolean> {
  readonly definition: Definition;
  readonly many: Many;
}
export type CheckpointReferenceSlots = Readonly<Record<string, ChildReferenceSlot>>;
export type SavedReferences<Slots extends CheckpointReferenceSlots> = { readonly [Key in keyof Slots]: Slots[Key] extends ChildReferenceSlot<infer Definition, infer Many> ? (Many extends true ? readonly ChildReference<Definition>[] : ChildReference<Definition>) : never };
export type SavedReferenceFacts<Slots extends CheckpointReferenceSlots> = { readonly [Key in keyof Slots]: Slots[Key] extends ChildReferenceSlot<infer Definition, infer Many> ? (Many extends true ? readonly ChildFact<Definition>[] : ChildFact<Definition>) : never };
