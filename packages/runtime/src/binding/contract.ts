import type { CallableContext, InvocationWork, InvocationFact } from '@weiliang0121/capix-invocation';
import type { ResourceRequirements, ResourceRefinement, ResourceIdentity } from '@weiliang0121/capix-resources';
import type { BoundChildren } from './children/bound.js';
import type { ObservationInstallation } from './observation.js';
import type { InvocationObservationDeclaration } from './observation.js';
import type { ChildResourceBinding } from './resources.js';
import type { AnyCallable } from './declarations.js';
import type { CallableSnapshot } from './snapshot.js';
import type { ChildCallable } from '@weiliang0121/capix-structure';

/** Assembly conditions are fixed once and shared by the single callable binder. */
export interface ChildBindingOptions {
  readonly observationProvides?: ResourceRequirements;
  readonly observations?: readonly ObservationInstallation[];
  readonly childResources?: readonly ChildResourceBinding[];
  readonly sources?: readonly ChildCallable[];
  readonly resourceScopes?: ReadonlyMap<AnyCallable, readonly ResourceIdentity[]>;
}

export interface CallableBinding<Input, Output, Resources extends object> {
  readonly definition: AnyCallable;
  readonly declaration: CallableSnapshot;
  readonly children: BoundChildren;
  readonly composite: boolean;
  readonly deps: ResourceRequirements<Resources>;
  readonly supply: ResourceRequirements;
  readonly refinements?: readonly ResourceRefinement<Input>[];
  readonly work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>;
  readonly observations: readonly InvocationObservationDeclaration[];
}
