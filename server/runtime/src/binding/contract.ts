import type { CallableContext } from '../context/callable.js';
import type { InvocationWork } from '../invocation/work.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRefinement } from '../resource/offer.js';
import type { BoundChildren } from './children/bound.js';
import type { ObservationInstallation } from './observation.js';
import type { ChildResourceBinding } from './resources.js';
import type { AnyCallableDefinition } from './declarations.js';
import type { ChildDefinition } from '../definition/children.js';

/** Assembly conditions are fixed once and shared by the single callable binder. */
export interface ChildBindingOptions {
  readonly observationProvides?: ResourceRequirements;
  readonly observations?: readonly ObservationInstallation[];
  readonly childResources?: readonly ChildResourceBinding[];
  readonly sources?: readonly ChildDefinition[];
}

export interface CallableBinding<Input, Output, Resources extends object> {
  readonly definition: AnyCallableDefinition;
  readonly declaration: AnyCallableDefinition;
  readonly children: BoundChildren;
  readonly composite: boolean;
  readonly requires: ResourceRequirements<Resources>;
  readonly supply: ResourceRequirements;
  readonly refinements?: readonly ResourceRefinement<Input>[];
  readonly work: InvocationWork<Input, Output, CallableContext<Input, Output, Resources>>;
}
