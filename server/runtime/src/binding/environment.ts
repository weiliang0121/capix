import type { ObservationDeclarationScope, ObservationInstallation } from '../observation/binding.js';
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
import { Execution } from '../execution/execution.js';
import type { ExecutionInvocationBuilder } from '../invocation/execution/builder.js';

/** Runtime-owned construction capabilities, never passed to content definitions. */
export class BindingEnvironment {
  constructor(
    private readonly executions: ExecutionInvocationBuilder,
    private readonly operations: OperationInvocationBuilder,
    private readonly attempts: AttemptInvocationBuilder,
    private readonly localObservationResources?: ResourceRequirements,
    private readonly observations?: readonly ObservationInstallation[],
  ) {}
  resources(definition: Parameters<typeof definitionResources>[0]): ResourceRequirements<any> {
    return definitionResources(definition, this.localObservationResources) as ResourceRequirements<any>;
  }
  children(requires: ResourceRequirements, definitions: readonly ChildDefinition[], level: 'runtime' | 'execution' | 'operation' | 'attempt', owner?: ObservationDeclarationScope): BoundChildren {
    this.check(requires, definitions, level, new Set(), owner);
    return new BoundChildren(definitions, (definition) =>
      definition.level === 'execution'
        ? new Execution(this.executions, definition, this.children(this.resources(definition), definition.children, 'execution', definition), this.resources(definition))
        : definition.level === 'operation'
          ? new Operation(this.operations, definition, this.children(this.resources(definition), definition.children, 'operation', definition), this.resources(definition))
          : new Attempt(
              this.attempts,
              definition,
              new BoundChildren([], () => {
                throw new Error('Attempts cannot have children');
              }),
              this.resources(definition),
            ),
    );
  }
  private check(requires: ResourceRequirements, definitions: readonly ChildDefinition[], level: string, path: Set<ChildDefinition>, owner?: ObservationDeclarationScope): void {
    for (const definition of definitions) {
      if (!isFunction(definition.run?.execute)) throw new Error('Child definition requires execute');
      if (definition.level !== 'execution' && definition.level !== 'operation' && definition.level !== 'attempt') throw new Error('Invalid child definition level');
      if (level === 'attempt' || (level === 'runtime' && definition.level !== 'execution') || (level === 'execution' && definition.level !== 'operation') || (level === 'operation' && definition.level === 'execution')) throw new Error('Invalid child definition level');
      for (const observation of this.observations ?? []) observation.check?.(definition, owner);
      if (path.has(definition)) throw new Error('Cyclic child declaration');
      // R binds E's supplies independently; its work is not granted every E resource.
      if (level !== 'runtime') checkResourceRequests(requires, resourceRequests(this.resources(definition)));
      const children = definition.level === 'operation' || definition.level === 'execution' ? definition.children : [];
      for (const child of [...(definition.run.uses ?? children), ...(definition.exceptions?.uses ?? [])]) {
        if (!children.includes(child)) throw new Error('Declaration uses a child outside its owner');
      }
      if (definition.level === 'operation' || definition.level === 'execution') {
        path.add(definition);
        this.check(this.resources(definition), definition.children, definition.level, path, definition);
        path.delete(definition);
      }
    }
  }
}
