import type { ChildDefinition } from './children.js';

/** Membership is an optional structural capability; the owner decides how members are used. */
export interface Composite<Members extends readonly ChildDefinition[] = readonly ChildDefinition[]> {
  readonly members: Members;
}
