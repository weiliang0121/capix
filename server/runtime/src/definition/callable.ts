import type { CallableKind } from '@capix/protocol';
import type { OutputDeclaration } from '../output/contract.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ChildContractsOf } from './children.js';
import type { InvocationCheckpointDefinition } from './checkpoint.js';
import type { CallableWork } from './work.js';
import type { NamedWork } from './composition.js';

export type { InvocationCheckpointPoint, InvocationCheckpointDefinition } from './checkpoint.js';
export type EmptyResources = Readonly<Record<never, never>>;

export type CallableRun<Input, Output, Kind extends CallableKind, Resources extends object, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>, Delta = never, Owner = unknown> = (work: NamedWork<CallableWork<Kind, Input, Output, Resources, Allowed, Delta>, Owner, Allowed>) => Output | Promise<Output>;

/** Explanatory metadata and producer contracts do not create extra business stages. */
export interface CallableDescription<Input, Output, Kind extends CallableKind, Delta = never> {
  readonly kind?: never;
  readonly members?: never;
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly output?: OutputDeclaration<Output, Delta>;
  readonly checkpoint?: InvocationCheckpointDefinition<Input, Output, Kind, Delta>;
}

/** The same fields may be supplied initially or assigned before build. */
type RequiredDependencies<Resources extends object> = [keyof Resources] extends [never] ? { readonly deps?: ResourceRequirements<Resources> } : { readonly deps: ResourceRequirements<Resources> };
export type CallableDefinition<Input, Output, Kind extends CallableKind, Resources extends object = EmptyResources, Delta = never> = CallableDescription<Input, Output, Kind, Delta> & ({ readonly deps?: ResourceRequirements<Resources>; readonly run?: undefined } | (RequiredDependencies<Resources> & { readonly run: CallableRun<Input, Output, Kind, Resources, ChildContractsOf<Kind>, Delta> }));
