import type { InvocationLevel } from '@capix/protocol';
import type { CheckpointCodec, CheckpointContract } from '../checkpoint/contract.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRequests, ResourcesOf } from '../resource/offer.js';
import type { ChildDefinition, ChildrenOf, ChildFact, ChildFacts, ChildReference } from './children.js';
import type { ContinuationFact, ResumeWork } from './work.js';

export interface ChildReferenceSlot<Definition extends ChildDefinition = ChildDefinition, Many extends boolean = boolean> {
  readonly definition: Definition;
  readonly many: Many;
}
export type CheckpointReferenceSlots = Readonly<Record<string, ChildReferenceSlot>>;
export type SavedReferences<Slots extends CheckpointReferenceSlots> = { readonly [Key in keyof Slots]: Slots[Key] extends ChildReferenceSlot<infer Definition, infer Many> ? (Many extends true ? readonly ChildReference<Definition>[] : ChildReference<Definition>) : never };
export type SavedReferenceFacts<Slots extends CheckpointReferenceSlots> = { readonly [Key in keyof Slots]: Slots[Key] extends ChildReferenceSlot<infer Definition, infer Many> ? (Many extends true ? readonly ChildFact<Definition>[] : ChildFact<Definition>) : never };

export function childReference<Definition extends ChildDefinition>(definition: Definition): ChildReferenceSlot<Definition, false> {
  return Object.freeze({ definition, many: false });
}
export function childReferences<Definition extends ChildDefinition>(definition: Definition): ChildReferenceSlot<Definition, true> {
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
export interface CheckpointPointOwner<Level extends InvocationLevel, Input, Output, Delta> {
  readonly [checkpointOwner]?: (owner: { readonly level: Level; readonly input: Input; readonly output: Output }) => { readonly level: Level; readonly input: Input; readonly output: Output; readonly delta: Delta };
}

export interface InvocationCheckpointPoint<Input, Output, Level extends InvocationLevel, State, Resources extends object = Record<string, never>, Slots extends CheckpointReferenceSlots = CheckpointReferenceSlots, Allowed extends ChildrenOf<Level> = ChildrenOf<Level>, Delta = never> extends CheckpointPointOwner<Level, Input, Output, Delta> {
  readonly name: string;
  readonly state: CheckpointCodec<State>;
  readonly references: Slots;
  check?(state: State, facts: CheckpointFacts<Input, Slots>): void;
  readonly resume: {
    readonly requires: ResourceRequirements<Resources>;
    readonly uses?: readonly Allowed[];
    execute(work: ResumeWork<Level, Input, Output, Resources, Allowed, Delta>, state: State, saved: SavedReferences<Slots>): Output | Promise<Output>;
  };
}

/** The point's concrete state/resources remain known to its author; storage is heterogeneous. */
export interface InvocationCheckpointDefinition<Input, Output, Level extends InvocationLevel, Delta = never> extends CheckpointContract {
  readonly input: CheckpointCodec<Input>;
  readonly output: CheckpointCodec<Output>;
  readonly points: readonly InvocationCheckpointPoint<Input, Output, Level, any, any, any, any, Delta>[];
}

export interface AuthorCheckpointWriter<Level extends InvocationLevel, Input, Output, Delta = never> {
  save<Point extends CheckpointPointOwner<Level, Input, Output, Delta> & { readonly state: CheckpointCodec<unknown>; readonly references: CheckpointReferenceSlots }>(point: Point, state: NoInfer<Point extends { readonly state: CheckpointCodec<infer State> } ? State : never>, references: NoInfer<SavedReferences<Point['references']>>): void;
}

interface PointOptions<Level extends InvocationLevel, Input, Output, State, Slots extends CheckpointReferenceSlots, Requires extends ResourceRequests, Uses extends readonly ChildrenOf<Level>[], Delta> {
  readonly name: string;
  readonly state: CheckpointCodec<State>;
  readonly references: Slots & (Level extends 'attempt' ? Readonly<Record<string, never>> : CheckpointReferenceSlots);
  readonly check?: (state: State, facts: CheckpointFacts<Input, Slots>) => void;
  readonly resume: {
    readonly requires?: Requires;
    readonly uses?: Uses;
    readonly execute: (work: ResumeWork<Level, Input, Output, ResourcesOf<NoInfer<Requires>>, Uses[number], Delta>, state: State, saved: SavedReferences<Slots>) => Output | Promise<Output>;
  };
}

/** Owner I/O is explicit because an independent point cannot infer from later registration. */
export function checkpointPoint<Level extends InvocationLevel, Input, Output, Delta = never>() {
  return <State, const Slots extends CheckpointReferenceSlots, const Requires extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly ChildrenOf<Level>[] = readonly []>(options: PointOptions<Level, Input, Output, State, Slots, Requires, Uses, Delta>): InvocationCheckpointPoint<Input, Output, Level, State, ResourcesOf<Requires>, Slots, Uses[number], Delta> => {
    const requires = (options.resume.requires ?? {}) as ResourceRequirements<ResourcesOf<Requires>>;
    return Object.freeze({ name: options.name, state: options.state, references: options.references, check: options.check?.bind(options), resume: { requires, uses: options.resume.uses, execute: options.resume.execute.bind(options.resume) } });
  };
}
