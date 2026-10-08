import type { ExecutionDefinition } from './execution.js';
import type { ResourceProvider } from '../resource/offer.js';

export type ExecutionDefinitions = Readonly<Record<string, ExecutionDefinition<any, any, any>>>;

/** R declares available content and resource supplies; it is not an E invocation. */
export interface RuntimeDefinition<S, E extends ExecutionDefinitions> {
  readonly providers: readonly ResourceProvider<S>[];
  readonly executions: E;
}
