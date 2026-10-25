/** Business annotations cannot establish invocation lifecycle facts. */
export interface BusinessEvent {
  readonly event: string;
  readonly [field: string]: unknown;
}
