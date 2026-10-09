/** Already resolved by the call-record specialization; content owners do not interpret call hierarchy. */
export interface ChangeSource {
  readonly contextId: string;
  readonly callId: string;
  readonly executionId: string;
  readonly operationId?: string;
}

/** Runtime origin is independent of optional recording identity. Internal entity writers receive both explicitly. */
export interface ContentProvenance {
  readonly origin?: { readonly contextId: string };
  readonly source?: ChangeSource;
}
