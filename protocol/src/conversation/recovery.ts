/** Eligibility is a current host check, not a promise or a reserved continuation. */
export interface ConversationRecoverySummary {
  readonly contextId: string;
  readonly point: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface ConversationRecoveryRequest {
  readonly conversationId: string;
  readonly submissionId: string;
  readonly contextId: string;
}

/** Metadata emitted by a recovery activity; never a reconstructed historical call record. */
export interface ConversationRecoveryEvent {
  readonly entryId: string;
  readonly activityId: string;
  readonly contextId: string;
  readonly parentContextId?: string;
  readonly structureKind: 'scene' | 'group' | 'node';
  readonly sequence: number;
  readonly occurredAt: string;
  readonly kind: 'captured' | 'saved' | 'checking' | 'continued' | 'installed' | 'child-restored' | 'activity' | 'resource' | 'transcript' | 'memory' | 'failed' | 'finishing' | 'finished';
  readonly point?: string;
  readonly stage?: string;
  readonly status?: 'succeeded' | 'failed' | 'cancelled';
}

export interface ConversationRecoveryActivity {
  readonly complete: boolean;
  readonly events: readonly ConversationRecoveryEvent[];
}
