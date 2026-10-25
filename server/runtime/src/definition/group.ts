import type { CallableDefinition, EmptyResources } from './callable.js';

/** Business configuration for a Group; members are assembled on the Group itself. */
export type GroupDefinition<Input, Output, Resources extends object = EmptyResources, Delta = never> = CallableDefinition<Input, Output, 'group', Resources, Delta>;
