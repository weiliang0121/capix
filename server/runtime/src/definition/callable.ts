import type { CallableKind } from '@capix/protocol';
import type { OutputDeclaration } from '../output/contract.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRequests, ResourcesOf } from '../resource/offer.js';
import type { ChildContractsOf } from './children.js';
import type { ExceptionContract } from '../exception/contract.js';
import type { ObservationDeclaration } from './observation.js';
import type { InvocationFact } from '../observation/facts.js';
import type { InvocationCheckpointDefinition } from './checkpoint.js';
import type { AcceptWork, Continue, ExecuteWork, HandleWork, Resolution } from './work.js';
import type { NamedWork } from './composition.js';
import type { DefinitionReceptions } from './reception.js';

export type { InvocationCheckpointPoint, InvocationCheckpointDefinition } from './checkpoint.js';

export interface CallableRunDefinition<Input, Output, Kind extends CallableKind, Resources extends object, Delta = never, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>> {
  readonly deps: ResourceRequirements<Resources>;
  /** Omitted means all children declared by this owner. */
  readonly uses?: readonly Allowed[];
  run(work: ExecuteWork<Kind, Input, Output, Resources, Allowed, Delta>): Output | Promise<Output>;
  accept?(work: AcceptWork<Kind, Input, Output, Resources, Allowed>): Output | Continue<Input> | Promise<Output | Continue<Input>>;
}

export interface InvocationExceptionDefinition<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>> {
  readonly deps: ResourceRequirements<Resources>;
  readonly uses?: readonly Allowed[];
  readonly accepts: readonly ExceptionContract<unknown>[];
  handle(work: HandleWork<Kind, Input, Output, Resources, Allowed>): Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
}

export type EmptyResources = Readonly<Record<never, never>>;
type RequiredResources<Resources extends object> = [keyof Resources] extends [never] ? { readonly deps?: ResourceRequirements<Resources> } : { readonly deps: ResourceRequirements<Resources> };
type RequestedResources<Deps extends ResourceRequests> = { readonly deps?: Deps } & ([keyof Deps] extends [never] ? unknown : { readonly deps: Deps });
export type StageUses<Kind extends CallableKind> = readonly ChildContractsOf<Kind>[] | undefined;
export type StageAllowed<Kind extends CallableKind, Uses extends StageUses<Kind>> = Uses extends readonly ChildContractsOf<Kind>[] ? Uses[number] : ChildContractsOf<Kind>;

export type CallableRun<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>, Delta = never, Owner = unknown> = (work: NamedWork<ExecuteWork<Kind, Input, Output, Resources, Allowed, Delta>, Owner, Allowed>) => Output | Promise<Output>;

/** Advanced normal-phase behavior is separate from its processing function. */
export interface CallableRunOptions<Input, Output, Kind extends CallableKind, Resources extends object, Uses extends StageUses<Kind>, Owner = unknown> {
  readonly uses?: Uses;
  readonly accept?: (work: NamedWork<AcceptWork<Kind, Input, Output, Resources, StageAllowed<Kind, Uses>>, Owner, StageAllowed<Kind, Uses>>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
}

/** Constructor configuration may omit only an empty resource request. */
export type InvocationRunConfiguration<Input, Output, Kind extends CallableKind, Resources extends object, Delta = never, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>> = RequiredResources<Resources> & {
  readonly uses?: readonly Allowed[];
  readonly run: CallableRun<Input, Output, Kind, Resources, Allowed, Delta>;
  readonly accept?: (work: AcceptWork<Kind, Input, Output, Resources, Allowed>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
};
export type InvocationExceptionConfiguration<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind> = never> = RequiredResources<Resources> & {
  readonly uses?: readonly Allowed[];
  readonly accepts: readonly ExceptionContract<unknown>[];
  readonly handle: (work: HandleWork<Kind, Input, Output, Resources, Allowed>) => Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
};

/** A setter infers one stage from its own requests and actions, never from a previous stage. */
export type InferredRunDefinition<Input, Output, Kind extends CallableKind, Deps extends ResourceRequests, Uses extends StageUses<Kind>, Delta = never> = RequestedResources<Deps> & {
  readonly uses?: Uses;
  readonly run: CallableRun<Input, Output, Kind, ResourcesOf<NoInfer<Deps>>, StageAllowed<Kind, Uses>, Delta>;
  readonly accept?: (work: AcceptWork<Kind, Input, Output, ResourcesOf<NoInfer<Deps>>, StageAllowed<Kind, Uses>>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
};

export type InferredExceptionDefinition<Input, Output, Kind extends CallableKind, Deps extends ResourceRequests, Uses extends StageUses<Kind>> = RequestedResources<Deps> & {
  readonly uses?: Uses;
  readonly accepts: readonly ExceptionContract<unknown>[];
  readonly handle: (work: HandleWork<Kind, Input, Output, ResourcesOf<NoInfer<Deps>>, Uses extends readonly ChildContractsOf<Kind>[] ? Uses[number] : never>) => Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
};

/** Plain business configuration. Identity and membership belong to the callable object. */
export interface CallableDescription<Input, Output, Kind extends CallableKind, Delta = never> {
  readonly kind?: never;
  readonly members?: never;
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly callee?: string;
  readonly maxRounds?: 1 | 2;
  readonly raises?: readonly ExceptionContract<unknown>[];
  readonly output?: OutputDeclaration<Output, Delta>;
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly checkpoint?: InvocationCheckpointDefinition<Input, Output, Kind, Delta>;
  readonly receptions?: DefinitionReceptions<Kind>;
}

export type CallableDefinition<Input, Output, Kind extends CallableKind, Resources extends object = EmptyResources, ExceptionResources extends object = EmptyResources, Delta = never> = CallableDescription<Input, Output, Kind, Delta> &
  InvocationRunConfiguration<Input, Output, Kind, Resources, Delta> & {
    readonly exceptions?: InvocationExceptionConfiguration<Input, Output, Kind, ExceptionResources, ChildContractsOf<Kind>>;
  };

export type InferredCallableDefinition<Input, Output, Kind extends CallableKind, Deps extends ResourceRequests, Uses extends StageUses<Kind>, ExceptionDeps extends ResourceRequests, ExceptionUses extends StageUses<Kind>, Delta = never> = CallableDescription<Input, Output, Kind, Delta> &
  InferredRunDefinition<Input, Output, Kind, Deps, Uses, Delta> & {
    readonly exceptions?: InferredExceptionDefinition<Input, Output, Kind, ExceptionDeps, ExceptionUses>;
  };
