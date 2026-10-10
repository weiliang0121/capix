import type { InvocationContextView, ContextViewResources } from '../context/view.js';
import type { InvocationView } from '../invocation/view.js';
import type { Continuation, InvocationResolution } from '../invocation/result.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ChildBindings } from '../binding/children.js';
import type { ChildDefinition } from './children.js';
import type { ExceptionContract, DeclaredException } from '../exception/contract.js';
import type { ObservationDeclaration } from './observation.js';
import type { InvocationFact } from '../observation/facts.js';

export interface InvocationRunDefinition<Input, Output, ContextView extends InvocationContextView<Input, Output>, Resources extends object> {
  readonly requires: ResourceRequirements<Resources>;
  /** Omitted means all children declared by this owner. */
  readonly uses?: readonly ChildDefinition[];
  execute(context: ContextView, invocation: InvocationView<Input, Output, ContextView>, children: ChildBindings): Output | Promise<Output>;
  accept?(context: ContextView, output: Output, invocation: InvocationView<Input, Output, ContextView>, children: ChildBindings): Output | Continuation<Input> | Promise<Output | Continuation<Input>>;
}

export interface InvocationExceptionDefinition<Input, Output, ContextView extends InvocationContextView<Input, Output>, Resources extends object> {
  readonly requires: ResourceRequirements<Resources>;
  /** An exception handler receives no child call capabilities unless explicitly declared. */
  readonly uses?: readonly ChildDefinition[];
  readonly accepts: readonly ExceptionContract<any>[];
  handle(context: ContextView, exception: DeclaredException, invocation: InvocationView<Input, Output, ContextView>, children: ChildBindings): InvocationResolution<Input, Output> | Promise<InvocationResolution<Input, Output>>;
}

/** Owner declaration: work, handling and description are peers; none owns the others. */
export abstract class InvocationDefinition<Input, Output, ContextView extends InvocationContextView<Input, Output>, Resources extends object, ExceptionResources extends object = Record<string, never>> {
  readonly maxRounds: 1 | 2 = 1;
  readonly raises: readonly ExceptionContract<any>[] = [];
  abstract readonly run: InvocationRunDefinition<Input, Output, ContextView, Resources>;
  readonly exceptions?: InvocationExceptionDefinition<Input, Output, ContextViewResources<ContextView, ExceptionResources>, ExceptionResources>;
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
}
