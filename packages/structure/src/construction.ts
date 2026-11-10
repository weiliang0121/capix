/** Structural checks and configuration lifecycle used by a host's atomic builder. */
export { assertStructureConfigurable, beginStructureBuild, endStructureBuild, lockStructureConfiguration, structureParent } from './configuration.js';
export { checkMemberName } from './members.js';
export { childKinds } from './definition/kind.js';
export { callableDependencies, type CallableDependencies } from './definition/dependencies.js';
