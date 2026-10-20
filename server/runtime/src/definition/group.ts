import type { CallableDefinition, EmptyResources } from './callable.js';

/** Business configuration for a Group; members are assembled on the Group itself. */
export interface GroupDefinition<Input, Output, Resources extends object = EmptyResources, ExceptionResources extends object = EmptyResources, Delta = never> extends CallableDefinition<Input, Output, 'group', Resources, ExceptionResources, Delta> {}
