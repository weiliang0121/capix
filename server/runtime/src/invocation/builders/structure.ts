import { combineOutputReceivers } from '../../output/delivery.js';
import type { CallableInput, CallableOutput } from '../../definition/signature.js';
import type { AnyCallable } from '../../binding/declarations.js';
import type { CallableCallBindings } from '../../binding/calls.js';
import { callableConstruction, type AnyBuiltCallable, type BuiltCallable, type BuiltOptions } from '../../structure/construction.js';
import type { CallableInvocationStarted } from './callable.js';
import type { Invocation } from '../invocation.js';
import type { CallableContext } from '../../context/callable.js';
import type { InvocationControls } from '../../context/context.js';
import type { InvocationRelationOptions } from '../relation.js';
import type { CheckpointRestoration } from '../../checkpoint/contract.js';

export interface CallableInvocationCallbacks<Input, Output, Resources extends object> {
  readonly started?: CallableInvocationStarted<Input, Output, Resources>;
}

export function createCallableInvocation<Structure extends AnyCallable>(structure: Structure, parent: Invocation<unknown, unknown, CallableContext>, input: CallableInput<Structure>, options: InvocationRelationOptions = {}): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  const construction = callableConstruction(structure);
  construction.invocations.check(parent);
  const scope = construction.calls.require(parent.construction);
  return construct(structure, input, scope, {}, parent, options);
}

export function createRootInvocation<Structure extends AnyCallable, Options>(structure: BuiltCallable<Structure, Options>, input: NoInfer<CallableInput<Structure>>, options: NoInfer<Options>, controls?: InvocationControls): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>>;
export function createRootInvocation<Structure extends AnyBuiltCallable>(structure: Structure, input: NoInfer<CallableInput<Structure>>, options: NoInfer<BuiltOptions<Structure>>, controls?: InvocationControls): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>>;
export function createRootInvocation<Structure extends AnyCallable>(structure: Structure, input: CallableInput<Structure>, options: unknown, controls: InvocationControls = {}): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  const scope = callableConstruction(structure).calls.begin(options);
  return construct(structure, input, scope, controls);
}

export function restoreCallableInvocation<Structure extends AnyCallable>(structure: Structure, parent: Invocation<unknown, unknown, CallableContext>, contextId: string, options: InvocationRelationOptions = {}): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  const construction = callableConstruction(structure);
  construction.invocations.check(parent);
  const scope = construction.calls.require(parent.construction);
  return restore(structure, contextId, scope, {}, parent, options);
}

export function restoreRootInvocation<Structure extends AnyCallable, Options>(structure: BuiltCallable<Structure, Options>, contextId: string, options: NoInfer<Options>, controls?: InvocationControls): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>>;
export function restoreRootInvocation<Structure extends AnyBuiltCallable>(structure: Structure, contextId: string, options: NoInfer<BuiltOptions<Structure>>, controls?: InvocationControls): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>>;
export function restoreRootInvocation<Structure extends AnyCallable>(structure: Structure, contextId: string, options: unknown, controls: InvocationControls = {}): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  const scope = callableConstruction(structure).calls.begin(options);
  return restore(structure, contextId, scope, controls);
}

function restore<Structure extends AnyCallable>(structure: Structure, contextId: string, scope: CallableCallBindings, controls: InvocationControls, parent?: Invocation<unknown, unknown, CallableContext>, options: InvocationRelationOptions = {}) {
  const { binding, invocations } = callableConstruction(structure);
  return invocations.restoration(contextId, binding.work, binding.declaration.kind, parent?.context.id, (restoration) => {
    const input = binding.declaration.checkpoint!.input.decode(restoration.head.image.frame.input) as CallableInput<Structure>;
    return construct(structure, input, scope, controls, parent, options, restoration);
  });
}

function construct<Structure extends AnyCallable>(structure: Structure, input: CallableInput<Structure>, scope: CallableCallBindings, controls: InvocationControls, parent?: Invocation<unknown, unknown, CallableContext>, options: InvocationRelationOptions = {}, restore?: CheckpointRestoration): Invocation<CallableInput<Structure>, CallableOutput<Structure>, CallableContext<CallableInput<Structure>, CallableOutput<Structure>>> {
  const { binding, invocations } = callableConstruction(structure);
  const declaration = binding.declaration;
  const initial = restore ? declaration.checkpoint?.points.find((point) => point.name === restore.head.image.point)?.resume.deps : declaration.deps;
  if (!initial) throw new Error('Checkpoint point is not declared');
  const access = scope.open(structure, input, !!restore, parent?.context.resources.supply);
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
    supplied: access.supply,
    observation: binding.observations,
    description: { id: structure.id, name, label, source },
    work: binding.work,
    started: access.started,
    progress: access.progress,
    output: combineOutputReceivers(options.output, access.output),
    restore,
  });
}
