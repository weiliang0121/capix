import type { CallableDefinition, EmptyResources } from './callable.js';

/** Business configuration for a Scene; members are assembled on the Scene itself. */
export interface SceneDefinition<Input, Output, Resources extends object = EmptyResources, ExceptionResources extends object = EmptyResources, Delta = never> extends CallableDefinition<Input, Output, 'scene', Resources, ExceptionResources, Delta> {}
