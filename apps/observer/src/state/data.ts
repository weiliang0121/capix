import type { ConfigurationResponse, ExecutionSummary, MemoryObservation, MemoryRecord, Message, ResourceFact, ProcessRecord } from '@capix-observer/protocol';
import type { ConversationMessage } from '../observation/conversation.js';
import type { CallSpan } from '../observation/types.js';

export interface RoundContext {
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
  context: RoundContext;
}
export interface CallMemory {
  incoming: { id: string; topic: string; content: string; sourceIndexes: number[] }[];
  changes: MemoryRecord[];
}
export interface CallDetail extends CallSpan {
  children: CallSpan[];
  memory: CallMemory;
  resources: readonly ResourceFact[];
  localRounds: number;
  processEntries: { record: ProcessRecord; reused?: ProcessRecord }[];
}
export interface ExecutionDetail {
  id: string;
  startedAt: string;
  status: ExecutionSummary['status'];
  contextId: string;
  resources: readonly ResourceFact[];
  settings: unknown;
  transcriptRange: unknown;
  inputContent: string;
  answer: string;
  error?: CallSpan['error'];
  calls: ReadonlyMap<string, CallDetail>;
  children: CallSpan[];
  memory: CallMemory;
}
export interface AppData {
  config?: ConfigurationResponse;
  observationLoading: boolean;
  observationError?: unknown;
  conversationError?: string;
  busy: boolean;
  pending: string;
  runningId: string;
  conversation: readonly ConversationMessage[];
  messageCount: number;
  progress: string;
  rounds: readonly RoundView[];
  memory: MemoryView;
  details: ReadonlyMap<string, ExecutionDetail>;
}
export function emptyAppData(): AppData {
  return { observationLoading: false, busy: false, pending: '', runningId: '', conversation: [], messageCount: 0, progress: '', rounds: [], memory: { items: [] }, details: new Map() };
}

export interface SearchMatch {
  executionId: string;
  role: 'user' | 'assistant';
  snippet: string;
}

export interface MemoryView {
  items: (Omit<MemoryObservation['items'][number], 'sources'> & { sources: { transcriptId: string; index: number; message?: Readonly<Message>; state: 'loaded' | 'unloaded' | 'loading' | 'missing' | 'error'; error?: string }[] })[];
}
