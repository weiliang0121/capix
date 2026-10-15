import type { InvocationLevel } from '@capix/protocol';
import { isFunction } from 'es-toolkit/predicate';
import type { ChildDefinition } from '../definition/children.js';
import type { ObservationDeclarationScope } from '../definition/observation.js';
import { checkResourceRequests, resourceRequests, type ResourceRequirements } from '../resource/bindings.js';
import type { ChildBindingOptions } from './contract.js';
import { collectDefinitionRequirements } from './resources.js';

/** Fixed kernel relationships; binding remains specific to each child level. */
const childLevels: Readonly<Record<InvocationLevel, readonly ChildDefinition['level'][]>> = {
  runtime: ['execution'],
  execution: ['operation'],
  operation: ['operation', 'attempt'],
  attempt: [],
};

/** Validate the complete declaration graph before any lazy child structure is initialized. */
export function checkChildDeclarations(parentRequires: ResourceRequirements, definitions: readonly ChildDefinition[], parentLevel: InvocationLevel, options: ChildBindingOptions = {}, parent?: ObservationDeclarationScope): void {
  checkChildren(parentRequires, definitions, parentLevel, options, new Set(), parent);
}

function checkChildren(parentRequires: ResourceRequirements, definitions: readonly ChildDefinition[], parentLevel: InvocationLevel, options: ChildBindingOptions, path: Set<ChildDefinition>, parent?: ObservationDeclarationScope): void {
  for (const definition of definitions) {
    if (!isFunction(definition.run?.execute)) throw new Error('Child definition requires execute');
    if (definition.level !== 'execution' && definition.level !== 'operation' && definition.level !== 'attempt') throw new Error('Invalid child definition level');
    if (!childLevels[parentLevel]?.includes(definition.level)) throw new Error('Invalid child definition level');
    for (const observation of options.observations ?? []) observation.check?.(definition, parent);
    if (path.has(definition)) throw new Error('Cyclic child declaration');
    const childRequires = collectDefinitionRequirements(definition, options.observationProvides);
    // R binds E's supplies independently; its work is not granted every E resource.
    if (parentLevel !== 'runtime') checkResourceRequests(parentRequires, resourceRequests(childRequires));
    const children = definition.level === 'operation' || definition.level === 'execution' ? definition.children : [];
    const checkpointChildren = Object.values(definition.checkpoint?.points ?? {}).flatMap((point) => [...(point.resume.uses ?? [])]);
    for (const child of [...(definition.run.uses ?? children), ...(definition.exceptions?.uses ?? []), ...checkpointChildren]) {
      if (!children.includes(child)) throw new Error('Declaration uses a child outside its owner');
    }
    if (definition.level === 'operation' || definition.level === 'execution') {
      path.add(definition);
      checkChildren(childRequires, definition.children, definition.level, options, path, definition);
      path.delete(definition);
    }
  }
}
