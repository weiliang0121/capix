import { Callable } from './callable.js';
import type { NodeDefinition } from '../definition/node.js';
import type { EmptyResources } from '../definition/callable.js';

/** Direct processing with the same invocation contract and no member-composition methods. */
export class Node<Input = unknown, Output = unknown, Resources extends object = EmptyResources, Delta = never> extends Callable<Input, Output, 'node', Resources, Delta> {
  declare readonly members?: never;

  constructor(definition?: NodeDefinition<Input, Output, Resources, Delta>) {
    super('node', definition);
  }
}
