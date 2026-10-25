import type { CallableContext } from '../context/callable.js';
import type { InvocationWork } from '../invocation/work.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRefinement, ResourceIdentity } from '../resource/offer.js';
import type { BoundChildren } from './children/bound.js';
import type { ObservationInstallation } from './observation.js';
import type { InvocationObservationDeclaration } from './observation.js';
import type { InvocationFact } from '../observation/facts.js';
import type { ChildResourceBinding } from './resources.js';
import type { AnyCallable } from './declarations.js';
import type { CallableSnapshot } from './snapshot.js';
import type { ChildCallable } from '../definition/children.js';

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
