import { Callable } from './callable.js';
import type { ChildCallable } from '../definition/children.js';
import { claimStructureMembers } from './configuration.js';

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
