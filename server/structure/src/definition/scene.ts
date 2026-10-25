import type { CallableDefinition, EmptyResources } from './callable.js';

/** Business configuration for a Scene; members are assembled on the Scene itself. */
export type SceneDefinition<Input, Output, Resources extends object = EmptyResources, Delta = never> = CallableDefinition<Input, Output, 'scene', Resources, Delta>;
