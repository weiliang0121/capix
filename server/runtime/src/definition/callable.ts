import type { CallableKind } from '@capix/protocol';
import type { OutputDeclaration } from '../output/contract.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ChildContractsOf } from './children.js';
import type { ExceptionContract } from '../exception/contract.js';
import type { ObservationDeclaration } from './observation.js';
import type { InvocationFact } from '../observation/facts.js';
import type { InvocationCheckpointDefinition } from './checkpoint.js';
import type { AcceptWork, Continue, ExecuteWork, HandleWork, Resolution } from './work.js';
import type { invocationSignature, InvocationSignature } from './signature.js';
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

/** Work, handling and observation are peers. No handler receives an internal invocation. */
export abstract class CallableDefinition<Input, Output, Kind extends CallableKind, Resources extends object, ExceptionResources extends object = Record<string, never>, Delta = never> {
  abstract readonly kind: Kind;
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly callee?: string;
  declare readonly [invocationSignature]: InvocationSignature<Input, Output, Delta>;
  readonly maxRounds: 1 | 2 = 1;
  readonly raises: readonly ExceptionContract<unknown>[] = [];
  readonly output?: OutputDeclaration<Output, Delta>;
  abstract readonly run: InvocationRunDefinition<Input, Output, Kind, Resources, Delta>;
  readonly exceptions?: InvocationExceptionDefinition<Input, Output, Kind, ExceptionResources>;
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly checkpoint?: InvocationCheckpointDefinition<Input, Output, Kind, Delta>;
  readonly receptions?: DefinitionReceptions<Kind>;
}
