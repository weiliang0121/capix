import { types } from 'node:util';

const configuration = Symbol('callable-configuration');

interface StructureConfiguration {
  parent?: object;
  phase: 'configuring' | 'building' | 'built';
}

type ConfigurableStructure = object & { readonly [configuration]: StructureConfiguration };

/** Configuration ownership belongs to each structure, independently of any invocation. */
export function initializeStructureConfiguration(structure: object): void {
  Object.defineProperty(structure, configuration, { value: { phase: 'configuring' } satisfies StructureConfiguration });
}

function state(structure: object): StructureConfiguration {
  if (types.isProxy(structure)) throw new TypeError('Callable structures cannot be proxies');
  if (!Object.hasOwn(structure, configuration)) throw new TypeError('Callable configuration is not initialized');
  return (structure as ConfigurableStructure)[configuration];
}

export function assertStructureConfigurable(structure: object): void {
  const phase = state(structure).phase;
  if (phase !== 'configuring') throw new Error(phase === 'building' ? 'Callable structure configuration is locked while building' : 'Callable structure configuration is locked after build');
}

export function structureParent(structure: object): object | undefined {
  return state(structure).parent;
}

/** Check every ownership before claiming any member; duplicate additions retain the same parent. */
export function claimStructureMembers(owner: object, members: readonly object[]): void {
  for (const member of members) {
    const current = state(member);
    assertStructureConfigurable(member);
    if (current.parent && current.parent !== owner) throw new Error('Callable member already belongs to another parent');
  }
  for (const member of members) state(member).parent = owner;
}

/** Reserve configuration before any binding hook can invoke host code. */
export function beginStructureBuild(structure: object): void {
  assertStructureConfigurable(structure);
  state(structure).phase = 'building';
}

/** Release a failed build; successful installations stay permanently fixed. */
export function endStructureBuild(structure: object): void {
  const current = state(structure);
  if (current.phase === 'building') current.phase = 'configuring';
}

/** Called only after the full installation has passed validation. Business receivers remain mutable. */
export function lockStructureConfiguration(structure: object): void {
  state(structure).phase = 'built';
}
