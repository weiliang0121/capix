/** Already resolved by the call-record specialization; content owners do not interpret call hierarchy. */
export interface ChangeSource {
  readonly contextId: string;
  readonly callId: string;
  readonly executionId?: string;
  readonly operationId?: string;
}
