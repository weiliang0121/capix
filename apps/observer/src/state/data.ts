import type { FileTask, ConfigurationResponse, ExecutionSummary, MemoryObservation, MemoryRecord, Message, ResourceRecord, ProcessRecord, RelationChangeRecord } from '@capix/protocol';
import type { ConversationItem } from './conversation.js';
import type { CallSpan } from '../observation/types.js';
import type { CallGraphModel } from './graph.js';

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
  return { observationLoading: false, busy: false, queue: { waiting: [] }, runningId: '', conversation: [], messageCount: 0, rounds: [], memory: { items: [] }, details: new Map(), graphs: new Map() };
}

export interface SearchMatch {
  executionId: string;
  role: 'user' | 'assistant';
  snippet: string;
}

export interface MemoryView {
  items: (Omit<MemoryObservation['items'][number], 'sources'> & { sources: { transcriptId: string; index: number; message?: Readonly<Message>; state: 'loaded' | 'unloaded' | 'loading' | 'missing' | 'error'; error?: string }[] })[];
}
