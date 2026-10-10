/** Record IDs resolved by the invocation recording; content owners do not interpret record hierarchy. */
export interface RecordChangeSource {
  /** The actual invocation's Context identity. */
  readonly contextId: string;
  /** Invocation record identity, distinct from contextId and bound-structure identity. */
  readonly callId: string;
  readonly executionId?: string;
  readonly operationId?: string;
}
