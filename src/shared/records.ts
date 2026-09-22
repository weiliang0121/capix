import type { RuntimeErrorValue } from './errors.js';

/** Common record shape; concrete records define their own relations and body. */
export interface RuntimeRecord<T = unknown> {
  readonly id: string;
  readonly value: T;
}
export interface OperationValue<I = unknown, O = unknown> {
  input: I;
  output?: O;
  error?: RuntimeErrorValue;
}
export interface ExecutionValue<I = unknown, O = unknown> extends OperationValue<I, O> {
  settings: unknown;
  startedAt: string;
}
export interface ExecutionRecord<I = unknown, O = unknown> extends RuntimeRecord<ExecutionValue<I, O>> {
  readonly contextId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}
export interface OperationRecord<I = unknown, O = unknown> extends RuntimeRecord<OperationValue<I, O>> {
  readonly contextId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly executionId: string;
  readonly nodeId: string;
  readonly parentOperationId?: string;
  readonly operation: string;
  readonly label: string;
  readonly source: string;
  readonly caller: string;
  readonly callee: string;
}
export interface AttemptValue<I = unknown, O = unknown> {
  input: I;
  output?: O;
  error?: RuntimeErrorValue;
}
/** One invocation of a declared phase, not a child operation or a complete BCA cycle. */
export interface AttemptRecord<I = unknown, O = unknown> extends RuntimeRecord<AttemptValue<I, O>> {
  readonly contextId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly operationId: string;
  readonly phase: 'before' | 'commit' | 'after';
  readonly source: string;
  readonly caller: string;
  readonly callee: string;
}
/** callId addresses an execution, operation or attempt record. */
export interface RecordEvent {
  sequence: number;
  callId: string;
  type: 'call' | 'return' | 'throw';
  offsetMs: number;
}
/** Current execution records and their boundary events for observation. */
export interface RuntimeSnapshot {
  execution: ExecutionRecord;
  operations: OperationRecord[];
  attempts: AttemptRecord[];
  events: RecordEvent[];
}
