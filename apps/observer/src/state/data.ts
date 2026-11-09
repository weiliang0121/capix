import type { ObservationStatus } from '../observation/status.js';
import type { ConversationDescriptor, FileTask, ConfigurationResponse, ExecutionSummary, MemoryObservation, MemoryRecord, MemoryResultSource, Message, ResourceRecord, ProcessRecord, RelationChangeRecord, InvocationSummary, RecordingArchiveOrigin } from '@weiliang0121/capix-protocol';
import type { ConversationItem } from './conversation.js';
import type { CallSpan } from '../observation/types.js';
import type { CallGraphModel } from './graph.js';

export interface RoundSelectionSummary {
  inputCount: number;
  selectedCount: number;
  selectionComplete: boolean;
  selectedMessages: { index: number; entry?: { index: number; count: number; message: Readonly<Message> } }[];
}
export interface ObservedInvocation extends Omit<InvocationSummary, 'status'> {
  status: ObservationStatus;
}
export interface RoundView extends Omit<ExecutionSummary, 'response' | 'status' | 'calls'> {
  status: ObservationStatus;
  calls: readonly ObservedInvocation[];
  transcriptId: string;
  messagesLoaded: boolean;
  response?: { index?: number; content?: string };
  inputContent: string;
  context: RoundSelectionSummary;
}
export interface CallMemory {
  incoming: { id: string; topic: string; content: string; sourceIndexes: number[]; sourceResults?: readonly MemoryResultSource[] }[];
  changes: MemoryRecord[];
}
export interface CallDetail extends Omit<CallSpan, 'recordType' | 'caller' | 'callee'> {
  recordType: CallSpan['recordType'];
  caller: CallSpan['caller'];
  callee: CallSpan['callee'];
  startedAt?: string;
  relationEntries: readonly RelationChangeRecord[];
  children: CallSpan[];
  memory: CallMemory;
  resources: readonly ResourceRecord[];
  localRounds: number;
  processEntries: { record: ProcessRecord; reused?: ProcessRecord }[];
}
export interface ExecutionDetail {
  id: string;
  startedAt: string;
  status: ObservationStatus;
  archive?: RecordingArchiveOrigin;
  contextId: string;
  resources: readonly ResourceRecord[];
  settings: unknown;
  settingsState: 'available' | 'unavailable' | 'multiple' | 'inconsistent';
  transcriptRange: unknown;
  inputContent: string;
  answer: string;
  error?: CallSpan['error'];
  failure?: CallSpan['failure'];
  calls: ReadonlyMap<string, CallDetail>;
  children: CallSpan[];
  memory: CallMemory;
}
export interface AppData {
  activeConversation?: ConversationDescriptor;
  conversations: readonly ConversationDescriptor[];
  switchingConversation: boolean;
  canSwitchConversation: boolean;
  conversationError?: string;
  trackingNotice?: string;
  config?: ConfigurationResponse;
  observationLoading: boolean;
  observationReconnectable: boolean;
  observationError?: unknown;
  observationNotice?: string;
  conversationSync?: { message: string; reconnect: boolean };
  submissionControl?: SubmissionControl;
  queue: ConversationQueueView;
  busy: boolean;
  runningId: string;
  conversation: readonly ConversationItem[];
  messageCount: number;
  rounds: readonly RoundView[];
  memory: MemoryView;
  details: ReadonlyMap<string, ExecutionDetail>;
  graphs: ReadonlyMap<string, CallGraphModel>;
}
export interface SubmissionNotice {
  message: string;
  reconnect: boolean;
  abandon?: boolean;
}
export interface SubmissionControl {
  id: string;
  label: string;
  disabled: boolean;
}
export interface ConversationQueueView {
  readonly waiting: readonly { readonly id: string; readonly pending: string; readonly fileTask?: FileTask }[];
  readonly blocked?: string;
}
export function emptyAppData(): AppData {
  return { conversations: [], switchingConversation: false, canSwitchConversation: false, observationLoading: false, observationReconnectable: false, busy: false, queue: { waiting: [] }, runningId: '', conversation: [], messageCount: 0, rounds: [], memory: { items: [] }, details: new Map(), graphs: new Map() };
}

export interface SearchMatch {
  executionId: string;
  role: 'user' | 'assistant';
  snippet: string;
}

export interface MemoryView {
  items: (Omit<MemoryObservation['items'][number], 'sources'> & { sources: { transcriptId: string; index: number; message?: Readonly<Message>; state: 'loaded' | 'unloaded' | 'loading' | 'missing' | 'error'; error?: string }[] })[];
}
