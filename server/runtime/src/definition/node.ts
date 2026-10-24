import type { CallableDefinition, EmptyResources } from './callable.js';

/** Business configuration for a Node; no member or child-call capability is introduced. */
export type NodeDefinition<Input, Output, Resources extends object = EmptyResources, ExceptionResources extends object = EmptyResources, Delta = never> = CallableDefinition<Input, Output, 'node', Resources, ExceptionResources, Delta>;
