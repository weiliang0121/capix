import type { MemoryViewValue } from '../content/memory.js';
import type { MessageLocator } from '../content/transcript.js';
import type { CallableRecord, InvocationBoundaryRecord } from '../recording/types.js';
import type { ResourceRecord } from '../recording/resource.js';
import type { TranscriptRecord } from '../recording/transcript.js';
import type { MemoryRecord } from '../recording/memory.js';
import type { ConversationAdmission } from './delivery.js';
import type { ConversationSubmissionBaseline } from './preview.js';

/** A single persistent conversation served by the new assembly. No model credentials or runtime objects. */
export interface ConversationServiceInfo {
  readonly conversationId: string;
  readonly transcriptId: string;
  readonly mode: 'demo' | 'live';
  /** Host-selected answer strategy, independent of demo/live provider selection. */
  readonly answerMode?: 'material' | 'tools';
  readonly model: string;
  readonly admission: ConversationAdmission;
  readonly active?: ConversationSubmissionBaseline;
}

/** One actual Scene invocation, independent of the lifetime of its HTTP submission. */
export interface ConversationCallSummary {
  readonly id: string;
  readonly contextId: string;
  readonly name?: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly startedAt?: string;
  readonly input?: MessageLocator;
  readonly answer?: MessageLocator;
}

/** Explicit process-local capture; stopping drains only calls already selected. */
export type ConversationRecordingState = { readonly status: 'idle'; readonly recorderId?: never } | { readonly status: 'recording' | 'stopping' | 'stopped'; readonly recorderId: string };

/** Explicit inspection, not part of every output delta. Contents are current entity facts. */
export interface ConversationInspection {
  readonly transcriptId: string;
  readonly memories: {
    readonly id: string;
    readonly sequence: number;
    readonly items: readonly { readonly id: string; readonly value: MemoryViewValue }[];
  };
  readonly view: {
    readonly revision: number;
    readonly sources: Readonly<Record<'messages' | 'memories', { readonly id: string; readonly scope: string }>>;
    readonly members: readonly ({ readonly source: 'messages'; readonly key: number } | { readonly source: 'memories'; readonly key: string })[];
  };
  readonly recording: ConversationRecordingState & {
    readonly revision: number;
    readonly integrity: 'intact' | 'incomplete';
    /** Recent root calls in creation order, oldest first. */
    readonly calls: readonly ConversationCallSummary[];
    readonly omitted: number;
  };
}

/** Selected Scene subtree. Missing records are explicit; this does not authorize execution recovery. */
export interface ConversationCallDetail {
  readonly recorderId: string;
  readonly revision: number;
  readonly integrity: 'intact' | 'incomplete';
  readonly root: CallableRecord;
  readonly calls: readonly CallableRecord[];
  readonly resources: readonly ResourceRecord[];
  readonly transcripts: readonly TranscriptRecord[];
  readonly memories: readonly MemoryRecord[];
  readonly boundaries: readonly InvocationBoundaryRecord[];
  readonly truncated: boolean;
}
