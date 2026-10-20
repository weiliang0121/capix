import type { ChildCallable } from './children.js';

/** Membership is an optional structural capability; the owner decides how members are used. */
export interface Composite<Members extends readonly ChildCallable[] = readonly ChildCallable[]> {
  readonly members: Members;
}
