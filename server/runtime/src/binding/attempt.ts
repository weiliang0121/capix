import type { Attempt } from '../attempt/attempt.js';
import type { AttemptDefinition } from '../definition/attempt.js';
import type { DefinitionParent } from '../definition/children.js';
import type { InvocationRelationOptions } from '../invocation/relation.js';
import type { BoundChildren } from './children.js';
import { bindInvocationWork } from './work.js';

export class AttemptBinding<I, O, R extends object = object> {
  constructor(
    readonly structure: Attempt<I, O, R>,
    readonly definition: AttemptDefinition<I, O, R>,
    private readonly children: BoundChildren,
  ) {}
  get requires() {
    return this.definition.requires;
  }
  create(parent: DefinitionParent<AttemptDefinition<I, O, R>>, input: I, options: InvocationRelationOptions = {}) {
    return this.structure.create(parent, { input, requires: this.requires, description: this.definition, work: bindInvocationWork(this.definition, this.children), key: options.key });
  }
  async call(parent: DefinitionParent<AttemptDefinition<I, O, R>>, input: I): Promise<O> {
    return this.create(parent, input).run();
  }
}
