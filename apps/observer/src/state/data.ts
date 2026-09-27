import type { ConfigurationResponse, ExecutionSummary, MemoryObservation, MemoryRecord, ObserverOverview, ProcessRecord } from '@capix-observer/protocol';
import type { ConversationMessage } from '../observation/conversation.js';
import type { CallSpan } from '../observation/types.js';

export interface RoundContext {
  inputCount: number;
  selectedCount: number;
  selectionComplete: boolean;
  selectedMessages: { index: number; entry?: ObserverOverview['messages'][number] }[];
}
export interface RoundView extends ExecutionSummary {
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
  localRounds: number;
  processEntries: { record: ProcessRecord; reused?: ProcessRecord }[];
}
export interface ExecutionDetail {
  id: string;
  startedAt: string;
  status: ExecutionSummary['status'];
  contextId: string;
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
  busy: boolean;
  pending: string;
  runningId: string;
  conversation: readonly ConversationMessage[];
  messageCount: number;
  progress: string;
  rounds: readonly RoundView[];
  memory: MemoryObservation;
  details: ReadonlyMap<string, ExecutionDetail>;
}
export function emptyAppData(): AppData {
  return { busy: false, pending: '', runningId: '', conversation: [], messageCount: 0, progress: '', rounds: [], memory: { items: [] }, details: new Map() };
}

export interface SearchMatch {
  executionId: string;
  role: 'user' | 'assistant';
  snippet: string;
}
