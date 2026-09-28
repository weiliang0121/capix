/** Causal identity only; content objects never inspect invocation state or record status. */
export interface ChangeSource {
  readonly contextId: string;
}
