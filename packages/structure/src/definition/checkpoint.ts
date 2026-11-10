import type { ResourceRequirements, ResourceRequests, ResourcesOf } from '@weiliang0121/capix-resources';
import type { Stable, CallableKind, CheckpointCodec, CheckpointContract, ChildContract, ChildReferenceSlot, CheckpointReferenceSlots, SavedReferences, CheckpointFacts, CheckpointPointOwner } from '@weiliang0121/capix-contracts';
import type { ChildContractsOf } from './children.js';
import type { ResumeWork } from './work.js';
import type { DefinitionReceptions } from './reception.js';

type CheckpointReferenceSlotsFor<Kind extends CallableKind> = Kind extends 'node' ? Readonly<Record<string, never>> : Readonly<Record<string, ChildReferenceSlot<ChildContractsOf<Kind>>>>;
export function childReference<Definition extends ChildContract>(definition: Definition): ChildReferenceSlot<Definition, false> {
  return Object.freeze({ definition, many: false });
}
export function childReferences<Definition extends ChildContract>(definition: Definition): ChildReferenceSlot<Definition, true> {
  return Object.freeze({ definition, many: true });
}

/** Resume actions default to none; saved references may cover any legal direct child. */
export interface InvocationCheckpointPoint<Input, Output, Kind extends CallableKind, State, Resources extends object = Record<string, never>, Slots extends CheckpointReferenceSlotsFor<Kind> = CheckpointReferenceSlotsFor<Kind>, Allowed extends ChildContractsOf<Kind> = never, Delta = never> extends CheckpointPointOwner<Kind, Input, Output, Delta> {
  readonly name: string;
  readonly state: CheckpointCodec<State>;
  readonly references: Slots;
  check?(state: Stable<State>, facts: CheckpointFacts<Input, Slots>): void;
  readonly resume: {
    readonly deps: ResourceRequirements<Resources>;
    readonly uses?: readonly Allowed[];
    run(work: ResumeWork<Kind, Input, Output, Resources, Allowed, Delta>, state: Stable<State>, saved: SavedReferences<Slots>): Output | Stable<Output> | Promise<Output | Stable<Output>>;
  };
}

/** The point's concrete state/resources remain known to its author; storage is heterogeneous. */
export interface InvocationCheckpointDefinition<Input, Output, Kind extends CallableKind, Delta = never> extends CheckpointContract {
  readonly input: CheckpointCodec<Input>;
  readonly output: CheckpointCodec<Output>;
  readonly points: readonly InvocationCheckpointPoint<Input, Output, Kind, any, any, any, any, Delta>[];
  readonly receptions?: DefinitionReceptions<Kind>;
}

interface PointOptions<Kind extends CallableKind, Input, Output, State, Slots extends CheckpointReferenceSlotsFor<Kind>, Deps extends ResourceRequests, Uses extends readonly ChildContractsOf<Kind>[], Delta> {
  readonly name: string;
  readonly state: CheckpointCodec<State>;
  readonly references: Slots;
  readonly check?: (state: NoInfer<Stable<State>>, facts: CheckpointFacts<Input, NoInfer<Slots>>) => void;
  readonly resume: {
    readonly deps?: Deps;
    readonly uses?: Uses;
    readonly run: (work: ResumeWork<Kind, Input, Output, ResourcesOf<NoInfer<Deps>>, Uses[number], Delta>, state: NoInfer<Stable<State>>, saved: SavedReferences<NoInfer<Slots>>) => Output | Stable<Output> | Promise<Output | Stable<Output>>;
  };
}

/** Owner I/O is explicit because an independent point cannot infer from later registration. */
export function checkpointPoint<Kind extends CallableKind, Input, Output, Delta = never>() {
  return <State, const Slots extends CheckpointReferenceSlotsFor<Kind>, const Deps extends ResourceRequests = Readonly<Record<never, never>>, const Uses extends readonly ChildContractsOf<Kind>[] = readonly []>(options: PointOptions<Kind, Input, Output, State, Slots, Deps, Uses, Delta>): InvocationCheckpointPoint<Input, Output, Kind, State, ResourcesOf<Deps>, Slots, Uses[number], Delta> => {
    const deps = (options.resume.deps ?? {}) as ResourceRequirements<ResourcesOf<Deps>>;
    return Object.freeze({ name: options.name, state: options.state, references: options.references, check: options.check?.bind(options), resume: { deps, uses: options.resume.uses, run: options.resume.run.bind(options.resume) } });
  };
}
