import type { InvocationLevel } from '@capix/protocol';
import { isFunction } from 'es-toolkit/predicate';
import type { ChildDefinition } from '../definition/children.js';
import type { RuntimeDefinition } from '../definition/runtime.js';
import type { ExecutionDefinition } from '../definition/execution.js';
import type { OperationDefinition } from '../definition/operation.js';
import type { AttemptDefinition } from '../definition/attempt.js';
import { checkResourceRequests, resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import { isResourceRefinement, type ResourceRefinement } from '../resource/offer.js';
import type { ChildBindingOptions } from './contract.js';
import { collectDefinitionRequirements, type ChildResourceBinding } from './resources.js';
import { snapshotDefinition } from './snapshot.js';

type AnyRuntimeDefinition = RuntimeDefinition<any, any, any, any, any>;
type BindingDefinition = AnyRuntimeDefinition | ChildDefinition;

/** Fixed interpretation at one parent position; no Bound structure, source value or call state. */
export interface ResolvedDeclaration<Definition extends BindingDefinition, Child extends ResolvedChild = ResolvedChild> {
  readonly level: Definition['level'];
  readonly definition: Definition;
  readonly declaration: Definition;
  readonly requires: ResourceRequirements;
  readonly children: readonly Child[];
  readonly refinements?: readonly ResourceRefinement<any>[];
}
export type ResolvedRuntime<Input = any, Output = any, Resources extends object = any> = ResolvedDeclaration<RuntimeDefinition<Input, Output, Resources, any, any>, ResolvedExecution>;
export type ResolvedExecution<Input = any, Output = any, Resources extends object = any> = ResolvedDeclaration<ExecutionDefinition<Input, Output, Resources, any, any>, ResolvedOperation>;
export type ResolvedOperation<Input = any, Output = any, Resources extends object = any> = ResolvedDeclaration<OperationDefinition<Input, Output, Resources, any, any>, ResolvedOperation | ResolvedAttempt>;
export type ResolvedAttempt<Input = any, Output = any, Resources extends object = any> = ResolvedDeclaration<AttemptDefinition<Input, Output, Resources, any, any>, never>;
export type ResolvedChild = ResolvedExecution | ResolvedOperation | ResolvedAttempt;
type ResolvedNode = ResolvedRuntime | ResolvedChild;

const childLevels: Readonly<Record<InvocationLevel, readonly ChildDefinition['level'][]>> = {
  runtime: ['execution'],
  execution: ['operation'],
  operation: ['operation', 'attempt'],
  attempt: [],
};

/** Resolve the whole supplied graph once. A standalone child has no implied ancestor grants. */
export function resolveDeclaration<Input, Output, Resources extends object>(definition: RuntimeDefinition<Input, Output, Resources, any, any>, options?: ChildBindingOptions): ResolvedRuntime<Input, Output, Resources>;
export function resolveDeclaration<Input, Output, Resources extends object>(definition: ExecutionDefinition<Input, Output, Resources, any, any>, options?: ChildBindingOptions): ResolvedExecution<Input, Output, Resources>;
export function resolveDeclaration<Input, Output, Resources extends object>(definition: OperationDefinition<Input, Output, Resources, any, any>, options?: ChildBindingOptions): ResolvedOperation<Input, Output, Resources>;
export function resolveDeclaration<Input, Output, Resources extends object>(definition: AttemptDefinition<Input, Output, Resources, any, any>, options?: ChildBindingOptions): ResolvedAttempt<Input, Output, Resources>;
export function resolveDeclaration(definition: BindingDefinition, options?: ChildBindingOptions): ResolvedNode;
export function resolveDeclaration(definition: BindingDefinition, options: ChildBindingOptions = {}): ResolvedNode {
  const refinements = new Map<ChildDefinition, readonly ResourceRefinement<any>[]>();
  for (const binding of options.childResources ?? []) {
    if (binding.definition.level !== 'operation' && binding.definition.level !== 'attempt') throw new Error('Resource refinement requires a declared operation or attempt');
    if (refinements.has(binding.definition)) throw new Error('Duplicate child resource binding');
    refinements.set(binding.definition, Object.freeze([...binding.refinements]));
  }
  const encountered = new Set<BindingDefinition>();
  const path = new Set<BindingDefinition>();
  const visit = (current: BindingDefinition, parent?: { readonly level: InvocationLevel; readonly definition: BindingDefinition; readonly requires: ResourceRequirements }): ResolvedNode => {
    if (path.has(current)) throw new Error('Cyclic child declaration');
    if (!isFunction(current.run?.execute)) throw new Error('Child definition requires execute');
    if (!Object.hasOwn(childLevels, current.level) || (parent && !childLevels[parent.level].includes(current.level as ChildDefinition['level']))) throw new Error('Invalid child definition level');
    const declaration = snapshotDefinition(current);
    for (const observation of options.observations ?? []) observation.check?.(current, parent?.definition);
    const requires = collectDefinitionRequirements(declaration, options.observationProvides);
    if (parent && parent.level !== 'runtime') checkResourceRequests(parent.requires, resourceRequests(requires));
    const definitions: readonly ChildDefinition[] = declaration.level === 'attempt' ? [] : declaration.children;
    const points = declaration.checkpoint?.points ?? [];
    const names = new Set<string>();
    for (const point of points) {
      if (!point.name || names.has(point.name)) throw new Error('Checkpoint points need distinct registered names');
      names.add(point.name);
      for (const slot of Object.values(point.references as import('../definition/checkpoint.js').CheckpointReferenceSlots)) {
        if (!definitions.includes(slot.definition)) throw new Error('Checkpoint reference targets a child outside its owner');
      }
    }
    const checkpointUses = points.flatMap((point) => [...(point.resume.uses ?? [])]);
    for (const child of [...(declaration.run.uses ?? definitions), ...(declaration.exceptions?.uses ?? []), ...checkpointUses]) {
      if (!definitions.includes(child)) throw new Error('Declaration uses a child outside its owner');
    }
    const selected = current.level === 'runtime' ? undefined : refinements.get(current);
    if (selected) checkRefinements(declaration, requires, selected);
    const node = { level: declaration.level, definition: current, declaration, requires, refinements: selected };
    encountered.add(current);
    path.add(current);
    const children = definitions.map((child) => visit(child, node) as ResolvedChild);
    path.delete(current);
    // Parent/child levels were checked above; this restores their correlation after heterogeneous traversal.
    return Object.freeze({ ...node, children: Object.freeze(children) }) as ResolvedNode;
  };
  const resolved = visit(definition);
  for (const binding of options.childResources ?? []) {
    if (!encountered.has(binding.definition)) throw new Error('Resource refinement requires a declared operation or attempt');
  }
  return resolved;
}

function checkRefinements(definition: BindingDefinition, requires: ResourceRequirements, refinements: ChildResourceBinding['refinements']): void {
  if (definition.level !== 'operation' && definition.level !== 'attempt') throw new Error('Resource refinement requires a declared operation or attempt');
  const offers = new Set(resourceRequests(requires).map((request) => request.offer));
  const seen = new Set<ResourceRefinement<any>['offer']>();
  for (const refinement of refinements) {
    if (!isResourceRefinement(refinement)) throw new Error('Resource refinement was not issued by an offer');
    if (!offers.has(refinement.offer)) throw new Error(`Refined resource is not requested: ${refinement.offer.name}`);
    if (seen.has(refinement.offer)) throw new Error(`Duplicate resource refinement: ${refinement.offer.name}`);
    seen.add(refinement.offer);
  }
}
