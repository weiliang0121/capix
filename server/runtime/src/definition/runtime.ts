import type { ExecutionDefinition } from './execution.js';

/** R declares its sole execution content; resource supplies belong to assembly. */
export interface RuntimeDefinition<D extends ExecutionDefinition<any, any, any, any, any, any>> {
  readonly execution: D;
}
