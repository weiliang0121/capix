import { combineOutputReceivers, requireNotCancelled, type Invocation, type CallableContext, type InvocationControls, type InvocationRelationOptions, type CheckpointRestoration } from '@capix/invocation';
import type { CallableInput, CallableOutput, CallableDelta, InvocationOutputReceiver, InvocationIdentity, ProgressReceiver } from '@capix/contracts';
import type { CallableFeedback } from './feedback.js';
import type { AnyCallable } from '../binding/declarations.js';
import type { CallableCallScope } from '../binding/calls.js';
import { callableConstruction, type AnyBuiltCallable, type BuiltCallable, type BuiltOptions } from '../structure/construction.js';
import type { CallableInvocationStarted } from './invocation.js';

export interface CallableInvocationCallbacks<Input, Output, Resources extends object> {
  readonly started?: CallableInvocationStarted<Input, Output, Resources>;
}

/** Root invocation ports are separate from the host options used to select resource supply. */
export interface RootInvocationOptions<Output, Delta = unknown> extends InvocationControls {
  readonly output?: InvocationOutputReceiver<Output, Delta>;
  readonly feedback?: CallableFeedback;
  readonly created?: ProgressReceiver<InvocationIdentity>;
}

export function createCallableInvocation<Structure extends AnyCallable>(structure: Structure, parent: Invocation<unknown, unknown, CallableContext>, input: CallableInput<Structure>, options: InvocationRelationOptions = {}): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  const construction = callableConstruction(structure);
  construction.invocations.check(parent);
  const scope = construction.calls.require(parent.construction);
  return construct(structure, input, scope, {}, parent, options);
}

export function createRootInvocation<Structure extends AnyCallable, Options>(structure: BuiltCallable<Structure, Options>, input: NoInfer<CallableInput<Structure>>, options: NoInfer<Options>, controls?: RootInvocationOptions<CallableOutput<Structure>, CallableDelta<Structure>>): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>>;
export function createRootInvocation<Structure extends AnyBuiltCallable>(structure: Structure, input: NoInfer<CallableInput<Structure>>, options: NoInfer<BuiltOptions<Structure>>, controls?: RootInvocationOptions<CallableOutput<Structure>, CallableDelta<Structure>>): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>>;
export function createRootInvocation<Structure extends AnyCallable>(structure: Structure, input: CallableInput<Structure>, options: unknown, controls: RootInvocationOptions<CallableOutput<Structure>> = {}): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  if (controls.signal) requireNotCancelled(controls.signal);
  const scope = callableConstruction(structure).calls.begin(options, controls.feedback);
  return construct(structure, input, scope, controls);
}

export function restoreCallableInvocation<Structure extends AnyCallable>(structure: Structure, parent: Invocation<unknown, unknown, CallableContext>, contextId: string, options: InvocationRelationOptions = {}): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  const construction = callableConstruction(structure);
  construction.invocations.check(parent);
  const scope = construction.calls.require(parent.construction);
  return restore(structure, contextId, scope, {}, parent, options);
}

export function restoreRootInvocation<Structure extends AnyCallable, Options>(structure: BuiltCallable<Structure, Options>, contextId: string, options: NoInfer<Options>, controls?: RootInvocationOptions<CallableOutput<Structure>, CallableDelta<Structure>>): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>>;
export function restoreRootInvocation<Structure extends AnyBuiltCallable>(structure: Structure, contextId: string, options: NoInfer<BuiltOptions<Structure>>, controls?: RootInvocationOptions<CallableOutput<Structure>, CallableDelta<Structure>>): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>>;
export function restoreRootInvocation<Structure extends AnyCallable>(structure: Structure, contextId: string, options: unknown, controls: RootInvocationOptions<CallableOutput<Structure>> = {}): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  if (controls.signal) requireNotCancelled(controls.signal);
  const scope = callableConstruction(structure).calls.begin(options, controls.feedback);
  return restore(structure, contextId, scope, controls);
}

function restore<Structure extends AnyCallable>(structure: Structure, contextId: string, scope: CallableCallScope, controls: RootInvocationOptions<CallableOutput<Structure>>, parent?: Invocation<unknown, unknown, CallableContext>, options: InvocationRelationOptions = {}) {
  if (controls.signal) requireNotCancelled(controls.signal);
  const { binding, invocations } = callableConstruction(structure);
  return invocations.restoration(
    contextId,
    binding.work,
    binding.declaration.kind,
    parent?.context.id,
    (restoration) => {
      const input = binding.declaration.checkpoint!.input.decode(restoration.head.image.frame.input) as CallableInput<Structure>;
      return construct(structure, input, scope, controls, parent, options, restoration);
    },
    scope.feedback,
  );
}

function construct<Structure extends AnyCallable>(structure: Structure, input: CallableInput<Structure>, scope: CallableCallScope, controls: RootInvocationOptions<CallableOutput<Structure>>, parent?: Invocation<unknown, unknown, CallableContext>, options: InvocationRelationOptions = {}, restore?: CheckpointRestoration): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  const { binding, invocations } = callableConstruction(structure);
  const declaration = binding.declaration;
  const initial = restore ? declaration.checkpoint?.points.find((point) => point.name === restore.head.image.point)?.resume.deps : declaration.deps;
  if (!initial) throw new Error('Checkpoint point is not declared');
  const signal = parent?.context.signal ?? controls.signal;
  if (signal) requireNotCancelled(signal);
  const prepared = scope.prepare(structure, input, !!restore, parent?.context.resources.supply, signal);
  if (signal) requireNotCancelled(signal);
  const { name, label, source } = declaration;
  return invocations.create<CallableInput<Structure>, CallableOutput<Structure>, object>(input, {
    kind: declaration.kind,
    controls,
    parent,
    construction: scope,
    key: options.key,
    declarationPosition: options.declarationPosition,
    receiveFailure: options.receiveFailure,
    deps: binding.deps,
    supply: binding.supply,
    initial,
    refinements: binding.refinements,
    supplied: prepared.supply,
    observation: binding.observations,
    description: { id: structure.id, name, label, source },
    work: binding.work,
    started: prepared.started,
    progress: prepared.progress,
    output: combineOutputReceivers(controls.output, options.output, prepared.output),
    restore,
    feedback: scope.feedback,
  });
}
