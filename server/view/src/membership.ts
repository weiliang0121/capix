import type { ViewSources } from './source.js';
import type { ViewBasis, ViewReference, ViewState } from './types.js';
import { checkIdentity, checkKey, checkStamp, conflict, data, exactKeys, object, sameIdentity } from './value.js';

export function members<Sources extends ViewSources>(value: readonly ViewReference<Sources>[], slots: readonly string[]): readonly ViewReference<Sources>[] {
  if (!Array.isArray(value)) throw new TypeError('View members must be an array');
  const seen = new Map(slots.map((slot) => [slot, new Set<string | number>()]));
  const accepted = data(value);
  for (const member of accepted) {
    object(member);
    exactKeys(member, ['source', 'key']);
    if (typeof member.source !== 'string') throw new TypeError('View member source must be named');
    const keys = seen.get(member.source);
    if (!keys) throw new TypeError('View member refers to an unknown source');
    checkKey(member.key);
    if (keys.has(member.key)) throw new TypeError('View members must be unique');
    keys.add(member.key);
  }
  return accepted;
}

export function state<Sources extends ViewSources>(value: ViewState<Sources>): ViewState<Sources> {
  const accepted = data(value);
  object(accepted);
  exactKeys(accepted, ['revision', 'sources', 'members']);
  if (!Number.isSafeInteger(accepted.revision) || accepted.revision < 0) throw new TypeError('Invalid view revision');
  object(accepted.sources);
  const slots = Object.keys(accepted.sources);
  for (const slot of slots) {
    if (!slot.length) throw new TypeError('View source slots must be named');
    checkIdentity(accepted.sources[slot]);
    exactKeys(accepted.sources[slot]!, ['id', 'scope']);
  }
  return Object.freeze({ revision: accepted.revision, sources: accepted.sources, members: members(accepted.members, slots) });
}

export function basis<Sources extends ViewSources>(value: ViewBasis<Sources>, current: ViewState<Sources>): ViewBasis<Sources> {
  const accepted = data(value);
  object(accepted);
  exactKeys(accepted, ['viewRevision', 'sources']);
  if (accepted.viewRevision !== current.revision) conflict('View membership has changed');
  object(accepted.sources);
  exactKeys(accepted.sources, Object.keys(current.sources));
  for (const slot of Object.keys(current.sources)) {
    const stamp = accepted.sources[slot];
    checkStamp(stamp);
    if (!sameIdentity(stamp, current.sources[slot]!)) conflict('View source identity or scope has changed');
  }
  return accepted;
}

export function sameMembers<Sources extends ViewSources>(left: readonly ViewReference<Sources>[], right: readonly ViewReference<Sources>[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry.source === right[index]!.source && entry.key === right[index]!.key);
}
