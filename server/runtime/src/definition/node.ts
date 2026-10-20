import { CallableDefinition } from './callable.js';

/** Reusable node definition; call state is owned by Invocation. */
export abstract class NodeDefinition<Input, Output, Resources extends object = Record<string, never>, ExceptionResources extends object = Record<string, never>, Delta = never> extends CallableDefinition<Input, Output, 'node', Resources, ExceptionResources, Delta> {
  readonly kind = 'node' as const;
  declare readonly members?: never;
}
