import type { OutputDeclaration } from '../output/contract.js';
import type { InvocationContextView, ContextViewResources } from '../context/view.js';
import type { InvocationView, InvocationWorkView } from '../invocation/view.js';
import type { Continuation, InvocationResolution } from '../invocation/result.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import type { ChildBindings } from '../binding/children.js';
import type { ChildDefinition } from './children.js';
import type { ExceptionContract, DeclaredException } from '../exception/contract.js';
import type { ObservationDeclaration } from './observation.js';
import type { InvocationFact } from '../observation/facts.js';
import type { CheckpointCodec, CheckpointContract, InvocationCheckpointFrame } from '../checkpoint/contract.js';

/** One explicit continuation, with its own resource and child capability requirements. */
export interface InvocationCheckpointPoint<Input, Output, ContextView extends InvocationContextView<Input, Output>, State, Resources extends object = Record<string, never>, Delta = never> {
  readonly state: CheckpointCodec<State>;
  check?(frame: InvocationCheckpointFrame, state: State): void;
  readonly resume: {
    readonly requires: ResourceRequirements<Resources>;
    readonly uses?: readonly ChildDefinition[];
    execute(context: ContextViewResources<ContextView, Resources>, invocation: InvocationWorkView<Input, Output, ContextViewResources<ContextView, Resources>, Delta>, children: ChildBindings, state: State): Output | Promise<Output>;
  };
}

export interface InvocationCheckpointDefinition<Input, Output, ContextView extends InvocationContextView<Input, Output>, Delta = never> extends CheckpointContract {
  readonly input: CheckpointCodec<Input>;
  readonly output: CheckpointCodec<Output>;
  readonly points: Readonly<Record<string, InvocationCheckpointPoint<Input, Output, ContextView, any, any, Delta>>>;
}

export interface InvocationRunDefinition<Input, Output, ContextView extends InvocationContextView<Input, Output>, Resources extends object, Delta = never> {
  readonly requires: ResourceRequirements<Resources>;
  /** Omitted means all children declared by this owner. */
  readonly uses?: readonly ChildDefinition[];
  execute(context: ContextView, invocation: InvocationWorkView<Input, Output, ContextView, Delta>, children: ChildBindings): Output | Promise<Output>;
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
export abstract class InvocationDefinition<Input, Output, ContextView extends InvocationContextView<Input, Output>, Resources extends object, ExceptionResources extends object = Record<string, never>, Delta = never> {
  readonly maxRounds: 1 | 2 = 1;
  readonly raises: readonly ExceptionContract<any>[] = [];
  readonly output?: OutputDeclaration<Output, Delta>;
  abstract readonly run: InvocationRunDefinition<Input, Output, ContextView, Resources, Delta>;
  readonly exceptions?: InvocationExceptionDefinition<Input, Output, ContextViewResources<ContextView, ExceptionResources>, ExceptionResources>;
  readonly observation?: readonly ObservationDeclaration<InvocationFact>[];
  readonly checkpoint?: InvocationCheckpointDefinition<Input, Output, ContextView, Delta>;
}
