import type { Message } from './transcript/message.js';
export type { Message } from './transcript/message.js';
import type { RuntimeErrorValue } from './errors.js';
import type { RecordEvent, RuntimeSnapshot } from './records.js';
export type Purpose = 'selection' | 'answer';
export type NodeStatus = 'running' | 'passed' | 'failed';
export interface QueryRequest {
  query: string;
  history: Message[];
}
export interface Answer {
  kind: 'answer' | 'unknown' | 'needs-info';
  content: string;
}
export interface Selection {
  historyIndexes: number[];
}
export interface ModelSettings {
  model: string;
  contextBudget: number;
  maxOutputTokens: number;
  timeoutMs: number;
}
export interface ModelRequest {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  response_format: { type: 'json_object' };
  thinking: { type: 'disabled' };
  max_tokens: number;
  stream: false;
}
export interface ModelOutput {
  id: string;
  model: string;
  content: string;
  finishReason: string;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}
export interface TraceNode {
  recordType: 'execution' | 'operation' | 'attempt';
  contextId: string;
  executionId?: string;
  operationInstanceId?: string;
  operation?: string;
  id: string;
  label: string;
  group: 'flow' | Purpose;
  source: string;
  status: NodeStatus;
  offsetMs?: number;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: RuntimeErrorValue;
}
export type ParticipantId = 'caller' | 'execution' | 'operation' | 'processing' | 'provider';
export interface CallSpan {
  recordType: 'execution' | 'operation' | 'attempt';
  contextId: string;
  executionId?: string;
  operationInstanceId?: string;
  operation?: string;
  id: string;
  parentId?: string;
  caller: ParticipantId;
  callee: ParticipantId;
  label: string;
  source: string;
  status: 'running' | 'passed' | 'failed';
  offsetMs: number;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: RuntimeErrorValue;
}
export interface CallSequence {
  version: 1;
  participants: { id: ParticipantId; label: string; description: string }[];
  calls: CallSpan[];
  events: RecordEvent[];
}
export interface Trace {
  facts: RuntimeSnapshot;
  id: string;
  startedAt: string;
  durationMs: number;
  status: 'running' | 'succeeded' | 'failed';
  request?: QueryRequest;
  settings: ModelSettings;
  nodes: TraceNode[];
  callSequence: CallSequence;
  result?: Answer;
  error?: RuntimeErrorValue;
}
export type TraceMessage = {
  type: 'trace';
  trace: RuntimeSnapshot;
};
