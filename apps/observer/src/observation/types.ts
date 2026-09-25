import type { RuntimeSnapshot, ProcessRecord, RuntimeErrorValue, EventRecord, ModelSettings, GenerationOutput } from '@capix-observer/protocol';
export type Purpose = 'selection' | 'answer' | 'memory';
export type NodeStatus = 'running' | 'passed' | 'failed';
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
  processes: readonly ProcessRecord[];
  output?: unknown;
  error?: RuntimeErrorValue;
}
export type ParticipantId = 'caller' | 'execution' | 'operation' | 'attempt';
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
  /** Recorded work target; distinct from the E/O/A invocation lane. */
  target?: string;
  label: string;
  source: string;
  status: 'running' | 'passed' | 'failed';
  offsetMs: number;
  durationMs?: number;
  input?: unknown;
  processes: readonly ProcessRecord[];
  output?: unknown;
  error?: RuntimeErrorValue;
}
export interface CallSequence {
  version: 1;
  participants: { id: ParticipantId; label: string; description: string }[];
  calls: CallSpan[];
  events: EventRecord[];
}
export interface Trace {
  facts: RuntimeSnapshot;
  id: string;
  startedAt: string;
  durationMs: number;
  status: 'running' | 'succeeded' | 'failed';
  settings: ModelSettings;
  nodes: TraceNode[];
  callSequence: CallSequence;
  result?: GenerationOutput;
  error?: RuntimeErrorValue;
}
