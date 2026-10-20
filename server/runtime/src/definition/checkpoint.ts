import type { CallableKind } from '@capix/protocol';
import type { CheckpointCodec, CheckpointContract } from '../checkpoint/contract.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRequests, ResourcesOf } from '../resource/offer.js';
import type { ChildContract, ChildContractsOf, ChildFact, ChildFacts, ChildReference } from './children.js';
import type { ContinuationFact, ResumeWork } from './work.js';

export interface ChildReferenceSlot<Definition extends ChildContract = ChildContract, Many extends boolean = boolean> {
  readonly definition: Definition;
  readonly many: Many;
}
export type CheckpointReferenceSlots = Readonly<Record<string, ChildReferenceSlot>>;
type CheckpointReferenceSlotsFor<Kind extends CallableKind> = Kind extends 'node' ? Readonly<Record<string, never>> : Readonly<Record<string, ChildReferenceSlot<ChildContractsOf<Kind>>>>;
export type SavedReferences<Slots extends CheckpointReferenceSlots> = { readonly [Key in keyof Slots]: Slots[Key] extends ChildReferenceSlot<infer Definition, infer Many> ? (Many extends true ? readonly ChildReference<Definition>[] : ChildReference<Definition>) : never };
export type SavedReferenceFacts<Slots extends CheckpointReferenceSlots> = { readonly [Key in keyof Slots]: Slots[Key] extends ChildReferenceSlot<infer Definition, infer Many> ? (Many extends true ? readonly ChildFact<Definition>[] : ChildFact<Definition>) : never };

export function childReference<Definition extends ChildContract>(definition: Definition): ChildReferenceSlot<Definition, false> {
  return Object.freeze({ definition, many: false });
}
export function childReferences<Definition extends ChildContract>(definition: Definition): ChildReferenceSlot<Definition, true> {
  return Object.freeze({ definition, many: true });
}

export interface CheckpointFacts<Input, Slots extends CheckpointReferenceSlots = CheckpointReferenceSlots> {
  readonly initialInput: Input;
  readonly input: Input;
  readonly round: 1 | 2;
  readonly continuation?: ContinuationFact;
  readonly references: SavedReferenceFacts<Slots>;
  readonly children: ChildFacts;
}

declare const checkpointOwner: unique symbol;
/** A type witness; registration and exact point identity are independently checked at binding. */
export interface CheckpointPointOwner<Kind extends CallableKind, Input, Output, Delta> {
  readonly [checkpointOwner]?: (owner: { readonly kind: Kind; readonly input: Input; readonly output: Output }) => { readonly kind: Kind; readonly input: Input; readonly output: Output; readonly delta: Delta };
}

/** Resume actions default to none; saved references may cover any legal direct child. */
export interface InvocationCheckpointPoint<Input, Output, Kind extends CallableKind, State, Resources extends object = Record<string, never>, Slots extends CheckpointReferenceSlotsFor<Kind> = CheckpointReferenceSlotsFor<Kind>, Allowed extends ChildContractsOf<Kind> = never, Delta = never> extends CheckpointPointOwner<Kind, Input, Output, Delta> {
  readonly name: string;
  readonly state: CheckpointCodec<State>;
  readonly references: Slots;
  check?(state: State, facts: CheckpointFacts<Input, Slots>): void;
  readonly resume: {
    readonly requires: ResourceRequirements<Resources>;
    readonly uses?: readonly Allowed[];
    execute(work: ResumeWork<Kind, Input, Output, Resources, Allowed, Delta>, state: State, saved: SavedReferences<Slots>): Output | Promise<Output>;
  };
}

/** The point's concrete state/resources remain known to its author; storage is heterogeneous. */
export interface InvocationCheckpointDefinition<Input, Output, Kind extends CallableKind, Delta = never> extends CheckpointContract {
  readonly input: CheckpointCodec<Input>;
  readonly output: CheckpointCodec<Output>;
  readonly points: readonly InvocationCheckpointPoint<Input, Output, Kind, any, any, any, any, Delta>[];
}

export interface AuthorCheckpointWriter<Kind extends CallableKind, Input, Output, Delta = never> {
  save<Point extends CheckpointPointOwner<Kind, Input, Output, Delta> & { readonly state: CheckpointCodec<unknown>; readonly references: CheckpointReferenceSlots }>(point: Point, state: NoInfer<Point extends { readonly state: CheckpointCodec<infer State> } ? State : never>, references: NoInfer<SavedReferences<Point['references']>>): void;
}

interface PointOptions<Kind extends CallableKind, Input, Output, State, Slots extends CheckpointReferenceSlotsFor<Kind>, Requires extends ResourceRequests, Uses extends readonly ChildContractsOf<Kind>[], Delta> {
  readonly name: string;
  readonly state: CheckpointCodec<State>;
  readonly references: Slots;
  readonly check?: (state: NoInfer<State>, facts: CheckpointFacts<Input, NoInfer<Slots>>) => void;
  readonly resume: {
    readonly requires?: Requires;
    readonly uses?: Uses;
    readonly execute: (work: ResumeWork<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, Uses[number], Delta>, state: NoInfer<State>, saved: SavedReferences<NoInfer<Slots>>) => Output | Promise<Output>;
  };
}

/** Owner I/O is explicit because an independent point cannot infer from later registration. */
export function checkpointPoint<Kind extends CallableKind, Input, Output, Delta = never>() {
  return <State, const Slots extends CheckpointReferenceSlotsFor<Kind>, const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly ChildContractsOf<Kind>[] = readonly []>(options: PointOptions<Kind, Input, Output, State, Slots, Requires, Uses, Delta>): InvocationCheckpointPoint<Input, Output, Kind, State, ResourcesOf<Requires>, Slots, Uses[number], Delta> => {
    const requires = (options.resume.requires ?? {}) as ResourceRequirements<ResourcesOf<Requires>>;
    return Object.freeze({ name: options.name, state: options.state, references: options.references, check: options.check?.bind(options), resume: { requires, uses: options.resume.uses, execute: options.resume.execute.bind(options.resume) } });
  };
}
