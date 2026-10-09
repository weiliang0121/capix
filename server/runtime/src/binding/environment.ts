import { definitionResources } from '../definition/invocation.js';
import { isFunction } from 'es-toolkit/predicate';
import type { OperationInvocationBuilder } from '../invocation/operation/builder.js';
import type { AttemptInvocationBuilder } from '../invocation/attempt/builder.js';
import type { ResourceRequirements } from '../resource/bindings.js';
import { checkResourceRequests, resourceRequests } from '../resource/bindings.js';
import type { ChildDefinition } from '../definition/children.js';
import { BoundChildren } from './children.js';
import { Operation } from '../operations/operation.js';
import { Attempt } from '../attempt/attempt.js';

/** Runtime-owned construction capabilities, never passed to content definitions. */
export class BindingEnvironment {
  constructor(
    private readonly operations: OperationInvocationBuilder,
    private readonly attempts: AttemptInvocationBuilder,
  ) {}
  children(requires: ResourceRequirements, definitions: readonly ChildDefinition[], level: 'execution' | 'operation' | 'attempt'): BoundChildren {
    this.check(requires, definitions, level, new Set());
    return new BoundChildren(definitions, (definition) =>
      definition.level === 'operation'
        ? new Operation(this.operations, definition, this.children(definitionResources(definition), definition.children, 'operation'))
        : new Attempt(
            this.attempts,
            definition,
            new BoundChildren([], () => {
              throw new Error('Attempts cannot have children');
            }),
          ),
    );
  }
  private check(requires: ResourceRequirements, definitions: readonly ChildDefinition[], level: string, path: Set<ChildDefinition>): void {
    for (const definition of definitions) {
      if (!isFunction(definition.run?.execute)) throw new Error('Child definition requires execute');
      if (definition.level !== 'operation' && definition.level !== 'attempt') throw new Error('Invalid child definition level');
      if (level === 'attempt' || (level === 'execution' && definition.level !== 'operation')) throw new Error('Invalid child definition level');
      if (path.has(definition)) throw new Error('Cyclic child declaration');
      checkResourceRequests(requires, resourceRequests(definitionResources(definition)));
      const children = definition.level === 'operation' ? definition.children : [];
      for (const child of [...(definition.run.uses ?? children), ...(definition.exceptions?.uses ?? [])]) {
        if (!children.includes(child)) throw new Error('Declaration uses a child outside its owner');
      }
      if (definition.level === 'operation') {
        path.add(definition);
        this.check(definitionResources(definition), definition.children, 'operation', path);
        path.delete(definition);
      }
    }
  }
}
