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
  readonly operationInstanceId: string;
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
/** The recorded boundary; its content is independent of record identity and timing. */
export interface EventValue {
  readonly type: 'call' | 'return' | 'throw';
}
/** callId addresses the invocation record, while id identifies this event record. */
export interface EventRecord extends RuntimeRecord<EventValue> {
  readonly executionId: string;
  readonly callId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly offsetMs: number;
}
/** Current execution records and their boundary events for observation. */
export interface RuntimeSnapshot {
  execution: ExecutionRecord;
  operations: OperationRecord[];
  attempts: AttemptRecord[];
  events: EventRecord[];
}
