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
import type { DefinitionReceptions } from './reception.js';

export type { InvocationCheckpointPoint, InvocationCheckpointDefinition } from './checkpoint.js';

export interface InvocationRunDefinition<Input, Output, Kind extends CallableKind, Resources extends object, Delta = never, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>> {
  readonly requires: ResourceRequirements<Resources>;
  /** Omitted means all children declared by this owner. */
  readonly uses?: readonly Allowed[];
  execute(work: ExecuteWork<Kind, Input, Output, Resources, Allowed, Delta>): Output | Promise<Output>;
  accept?(work: AcceptWork<Kind, Input, Output, Resources, Allowed>): Output | Continue<Input> | Promise<Output | Continue<Input>>;
}

export interface InvocationExceptionDefinition<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>> {
  readonly requires: ResourceRequirements<Resources>;
  readonly uses?: readonly Allowed[];
  readonly accepts: readonly ExceptionContract<unknown>[];
  handle(work: HandleWork<Kind, Input, Output, Resources, Allowed>): Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
}

export type EmptyResources = Readonly<Record<never, never>>;
type RequiredResources<Resources extends object> = [keyof Resources] extends [never] ? { readonly requires?: ResourceRequirements<Resources> } : { readonly requires: ResourceRequirements<Resources> };
type RequestedResources<Requires extends ResourceRequests> = { readonly requires?: Requires } & ([keyof Requires] extends [never] ? unknown : { readonly requires: Requires });
export type StageUses<Kind extends CallableKind> = readonly ChildContractsOf<Kind>[] | undefined;
export type StageAllowed<Kind extends CallableKind, Uses extends StageUses<Kind>> = Uses extends readonly ChildContractsOf<Kind>[] ? Uses[number] : ChildContractsOf<Kind>;

/** Constructor configuration may omit only an empty resource request. */
export type InvocationRunConfiguration<Input, Output, Kind extends CallableKind, Resources extends object, Delta = never, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>> = RequiredResources<Resources> & {
  readonly uses?: readonly Allowed[];
  readonly execute: (work: ExecuteWork<Kind, Input, Output, Resources, Allowed, Delta>) => Output | Promise<Output>;
  readonly accept?: (work: AcceptWork<Kind, Input, Output, Resources, Allowed>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
};
export type InvocationExceptionConfiguration<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind> = never> = RequiredResources<Resources> & {
  readonly uses?: readonly Allowed[];
  readonly accepts: readonly ExceptionContract<unknown>[];
  readonly handle: (work: HandleWork<Kind, Input, Output, Resources, Allowed>) => Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
};

/** A setter infers one stage from its own requests and actions, never from a previous stage. */
export type InferredRunDefinition<Input, Output, Kind extends CallableKind, Requires extends ResourceRequests, Uses extends StageUses<Kind>, Delta = never> = RequestedResources<Requires> & {
  readonly uses?: Uses;
  readonly execute: (work: ExecuteWork<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, StageAllowed<Kind, Uses>, Delta>) => Output | Promise<Output>;
  readonly accept?: (work: AcceptWork<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, StageAllowed<Kind, Uses>>) => Output | Continue<Input> | Promise<Output | Continue<Input>>;
};

export type InferredExceptionDefinition<Input, Output, Kind extends CallableKind, Requires extends ResourceRequests, Uses extends StageUses<Kind>> = RequestedResources<Requires> & {
  readonly uses?: Uses;
  readonly accepts: readonly ExceptionContract<unknown>[];
  readonly handle: (work: HandleWork<Kind, Input, Output, ResourcesOf<NoInfer<Requires>>, Uses extends readonly ChildContractsOf<Kind>[] ? Uses[number] : never>) => Resolution<Input, Output> | Promise<Resolution<Input, Output>>;
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

export interface CallableDefinition<Input, Output, Kind extends CallableKind, Resources extends object = EmptyResources, ExceptionResources extends object = EmptyResources, Delta = never> extends CallableDescription<Input, Output, Kind, Delta> {
  readonly run: InvocationRunConfiguration<Input, Output, Kind, Resources, Delta>;
  readonly exceptions?: InvocationExceptionConfiguration<Input, Output, Kind, ExceptionResources, ChildContractsOf<Kind>>;
}

export interface InferredCallableDefinition<Input, Output, Kind extends CallableKind, Requires extends ResourceRequests, Uses extends StageUses<Kind>, ExceptionRequires extends ResourceRequests, ExceptionUses extends StageUses<Kind>, Delta = never> extends CallableDescription<Input, Output, Kind, Delta> {
  readonly run: InferredRunDefinition<Input, Output, Kind, Requires, Uses, Delta>;
  readonly exceptions?: InferredExceptionDefinition<Input, Output, Kind, ExceptionRequires, ExceptionUses>;
}
