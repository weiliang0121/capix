import type { AttemptContext } from '../context/attempt.js';
import type { ExecutionContext } from '../context/execution.js';
import type { OperationContext } from '../context/operation.js';
import type { ExecutionBindingResolver, RuntimeContext } from '../context/runtime.js';
import type { AttemptDefinition } from '../definition/attempt.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { OperationDefinition } from '../definition/operation.js';
import type { RuntimeDefinition } from '../definition/runtime.js';
import type { InvocationWork } from '../invocation/work.js';
import type { InvocationProgress } from '../invocation/progress.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import type { ProgressReceiver } from '../progress.js';
import type { ResourceBindings, ResourceRequirements } from '../resource/bindings.js';
import type { ResourceRefinement } from '../resource/offer.js';
import type { BoundChildren } from './children/bound.js';
import type { ObservationInstallation } from './observation.js';
import type { ChildResourceBinding } from './resources.js';

/** Fixed assembly conditions shared by the E/O/A binders, never single-call state. */
export interface ChildBindingOptions {
  /** Undefined disables observation requirements; an empty map enables them without installation-provided offers. */
  readonly observationProvides?: ResourceRequirements;
  readonly observations?: readonly ObservationInstallation[];
  readonly childResources?: readonly ChildResourceBinding[];
}

export interface RuntimeBinding<Input, Output, Options, Resources extends object = object> {
  readonly definition: RuntimeDefinition<Input, Output, Resources, any, any>;
  readonly declaration: RuntimeDefinition<Input, Output, Resources, any, any>;
  readonly children: BoundChildren;
  readonly requires: ResourceRequirements<Resources>;
  readonly work: InvocationWork<Input, Output, RuntimeContext<Input, Output, Resources>>;
  validate?(options: Options): void;
  output?(input: Input, options: Options): InvocationOutputReceiver<Output> | undefined;
  progress?(input: Input, options: Options): ProgressReceiver<InvocationProgress> | undefined;
  resources(input: Input, options: Options): ResourceBindings<Resources>;
  executionBindings(input: Input, options: Options): ExecutionBindingResolver;
}

export interface ExecutionBinding<Input, Output, Resources extends object, EntryInput, EntryResources extends object> {
  readonly definition: ExecutionDefinition<Input, Output, Resources, EntryInput, EntryResources, any, any>;
  readonly declaration: ExecutionDefinition<Input, Output, Resources, EntryInput, EntryResources, any, any>;
  readonly children: BoundChildren;
  readonly requires: ResourceRequirements<Resources>;
  readonly work: InvocationWork<Input, Output, ExecutionContext<Input, Output, Resources>>;
}

export interface OperationBinding<Input, Output, Resources extends object> {
  readonly definition: OperationDefinition<Input, Output, Resources, any, any>;
  readonly declaration: OperationDefinition<Input, Output, Resources, any, any>;
  readonly children: BoundChildren;
  readonly requires: ResourceRequirements<Resources>;
  readonly refinements?: readonly ResourceRefinement<Input>[];
  readonly work: InvocationWork<Input, Output, OperationContext<Input, Output, Resources>>;
}

export interface AttemptBinding<Input, Output, Resources extends object> {
  readonly definition: AttemptDefinition<Input, Output, Resources, any, any>;
  readonly declaration: AttemptDefinition<Input, Output, Resources, any, any>;
  readonly children: BoundChildren;
  readonly requires: ResourceRequirements<Resources>;
  readonly refinements?: readonly ResourceRefinement<Input>[];
  readonly work: InvocationWork<Input, Output, AttemptContext<Input, Output, Resources>>;
}
