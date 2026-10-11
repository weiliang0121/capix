import type { ConfigurationResponse, ExecutionSummary, MemoryObservation, MemoryRecord, Message, ResourceRecord, ProcessRecord, RelationChangeRecord } from '@capix/protocol';
import type { ConversationMessage, ConversationProcess } from './conversation.js';
import type { CallSpan } from '../observation/types.js';

export interface RoundSelectionSummary {
  inputCount: number;
  selectedCount: number;
  selectionComplete: boolean;
  selectedMessages: { index: number; entry?: { index: number; count: number; message: Readonly<Message> } }[];
}
export interface RoundView extends Omit<ExecutionSummary, 'response'> {
  transcriptId: string;
  messagesLoaded: boolean;
  response?: { index?: number; content?: string };
  inputContent: string;
  context: RoundSelectionSummary;
}
export interface CallMemory {
  incoming: { id: string; topic: string; content: string; sourceIndexes: number[] }[];
  changes: MemoryRecord[];
}
export interface CallDetail extends Omit<CallSpan, 'recordType' | 'caller' | 'callee'> {
  recordType: CallSpan['recordType'] | 'runtime';
  caller: CallSpan['caller'] | 'runtime';
  callee: CallSpan['callee'] | 'runtime';
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
  status: ExecutionSummary['status'];
  contextId: string;
  resources: readonly ResourceRecord[];
  settings: unknown;
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
  config?: ConfigurationResponse;
  observationLoading: boolean;
  observationError?: unknown;
  conversationError?: string;
  submissionNotice?: SubmissionNotice;
  submissionControl?: SubmissionControl;
  queue: ConversationQueueView;
  busy: boolean;
  pending: string;
  pendingLabel: string;
  runningId: string;
  conversation: readonly ConversationMessage[];
  pendingProcesses: readonly ConversationProcess[];
  messageCount: number;
  progress: string;
  rounds: readonly RoundView[];
  memory: MemoryView;
  details: ReadonlyMap<string, ExecutionDetail>;
}
export interface SubmissionNotice {
  message: string;
  reconnect: boolean;
  input?: string;
}
export interface SubmissionControl {
  id: string;
  label: string;
  disabled: boolean;
}
export interface ConversationQueueView {
  readonly waiting: readonly { readonly id: string; readonly pending: string }[];
  readonly paused: boolean;
  readonly blocked?: string;
}
export function emptyAppData(): AppData {
  return { observationLoading: false, busy: false, queue: { waiting: [], paused: false }, pending: '', pendingLabel: '等待接纳', runningId: '', conversation: [], pendingProcesses: [], messageCount: 0, progress: '', rounds: [], memory: { items: [] }, details: new Map() };
}

export interface SearchMatch {
  executionId: string;
  role: 'user' | 'assistant';
  snippet: string;
}

export interface MemoryView {
  items: (Omit<MemoryObservation['items'][number], 'sources'> & { sources: { transcriptId: string; index: number; message?: Readonly<Message>; state: 'loaded' | 'unloaded' | 'loading' | 'missing' | 'error'; error?: string }[] })[];
}
