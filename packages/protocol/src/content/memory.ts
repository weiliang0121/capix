/** Deliberately narrow display DTO; this is not complete Memory content or recovery material.
 * Applications that expose metadata must define their own projection and encoding contract.
 */
export interface MemoryViewValue {
  readonly content: string;
}
