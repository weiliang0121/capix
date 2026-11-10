import type { CallableKind, InvocationProcessStage, InvocationRelationPhase } from '../invocation/types.js';
import type { ConversationFailure } from './delivery.js';

/** Current real ToolLoop child activity, not a transcript message or replayed CP history. */
export interface ConversationStage {
  readonly contextId: string;
  readonly kind: 'model' | 'tool';
  readonly label: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
}

/** Public call metadata for one submission. No inputs, outputs, source paths or model reasoning. */
export interface ConversationActivity {
  readonly contextId: string;
  readonly parentContextId?: string;
  readonly kind: CallableKind;
  readonly label: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  readonly phase: 'setup' | InvocationProcessStage;
  readonly round: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  /** The parent's handling of this child is independent of the child's own outcome. */
  readonly relation?: { readonly phase: InvocationRelationPhase; readonly returned?: 'succeeded' | 'failed' | 'cancelled' };
}

/** Bounded cumulative call states; an incomplete source cannot be repaired by later snapshots. */
export interface ConversationActivities {
  readonly calls: readonly ConversationActivity[];
  readonly integrity: { readonly status: 'complete' } | { readonly status: 'incomplete'; readonly error: ConversationFailure };
}

/** Changed call entries only; unchanged calls retain their identity in the replica. */
export interface ConversationActivityChange {
  readonly calls?: readonly ConversationActivity[];
  readonly integrity?: ConversationActivities['integrity'];
}
