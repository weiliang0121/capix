import type { Operation } from '../operations/operation.js';
import type { OperationDefinition } from '../definition/operation.js';
import type { DefinitionParent } from '../definition/children.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';
import type { BoundChildren } from './children.js';
import { bindInvocationWork } from './work.js';

export class OperationBinding<I, O, R extends object = object> {
  constructor(
    readonly structure: Operation<I, O, R>,
    readonly definition: OperationDefinition<I, O, R>,
    readonly children: BoundChildren,
  ) {}
  get id() {
    return this.structure.id;
  }
  get requires() {
    return this.definition.requires;
  }
  create(parent: DefinitionParent<OperationDefinition<I, O, R>>, input: I, options: InvocationRelationOptions = {}) {
    const { name, label, source } = this.definition;
    return this.structure.create(parent, { input, requires: this.requires, description: { name, label, source }, work: bindInvocationWork(this.definition, this.children), key: options.key });
  }
  async call(parent: DefinitionParent<OperationDefinition<I, O, R>>, input: I): Promise<O> {
    return this.create(parent, input).run();
  }
}
