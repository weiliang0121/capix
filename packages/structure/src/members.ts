import { types } from 'node:util';
import { Callable } from './callable.js';
import type { ChildCallable } from './definition/children.js';
import type { NamedMembers } from './definition/composition.js';
import { assertStructureConfigurable, claimStructureMembers } from './configuration.js';

export function requireChildCallable(value: unknown): asserts value is ChildCallable {
  if (types.isProxy(value)) throw new TypeError('Callable structures cannot be proxies');
  if (!(value instanceof Callable) || (value.kind !== 'node' && !(value.kind === 'group' && 'members' in value && Array.isArray(value.members)))) throw new TypeError('Members must be Group or Node objects');
}

/** Preflight all additions before changing membership; repeat registration preserves the original position. */
export function appendMembers(owner: { readonly kind: 'scene' | 'group' }, current: readonly ChildCallable[], additions: readonly ChildCallable[]): readonly ChildCallable[] {
  for (const member of additions) {
    if (!(member instanceof Callable) || (member.kind !== 'group' && member.kind !== 'node')) throw new TypeError('Members must be Group or Node objects');
    const visit = (candidate: ChildCallable, path: Set<object>): void => {
      if (candidate === owner || path.has(candidate)) throw new Error('Cyclic callable membership');
      if (candidate.kind === 'node') return;
      path.add(candidate);
      for (const child of candidate.members) visit(child, path);
      path.delete(candidate);
    };
    visit(member, new Set());
  }
  const next = [...current];
  for (const member of additions) if (!next.includes(member)) next.push(member);
  const members = Object.freeze(next);
  claimStructureMembers(owner, additions);
  return members;
}

const reservedNames = new Set(['invoke', 'create', 'open', 'facts', 'resume', 'prototype', ...Object.getOwnPropertyNames(Object.prototype)]);

export function checkMemberName(name: string): void {
  if (!name || reservedNames.has(name)) throw new TypeError(`Member name is reserved or empty: ${name}`);
}

/** Validate aliases before claiming any child, so rejected batches change no ownership. */
export function appendNamedMembers(owner: { readonly kind: 'scene' | 'group' }, current: readonly ChildCallable[], names: NamedMembers, additions: unknown): { readonly members: readonly ChildCallable[]; readonly names: NamedMembers } {
  if (!additions || typeof additions !== 'object' || Array.isArray(additions) || types.isProxy(additions)) throw new TypeError('Named members must be an object');
  if (Object.getOwnPropertySymbols(additions).length) throw new TypeError('Member names must be strings');
  const entries: [string, ChildCallable][] = [];
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(additions))) {
    if (!('value' in descriptor)) throw new TypeError('Named members must use data properties');
    const member: unknown = descriptor.value;
    requireChildCallable(member);
    entries.push([name, member]);
    checkMemberName(name);
    if (Object.hasOwn(names, name) && names[name] !== member) throw new Error(`Member name already belongs to another member: ${name}`);
  }
  const nextNames = Object.freeze({ ...names, ...Object.fromEntries(entries) });
  assertStructureConfigurable(owner);
  const members = appendMembers(
    owner,
    current,
    entries.map(([, member]) => member),
  );
  return { members, names: nextNames };
}
