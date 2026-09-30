import type { RuntimeErrorValue } from './errors.js';

/** Common record shape; concrete records define their own relations and body. */
export interface BaseRecord<T = unknown> {
  readonly id: string;
  /** Direct parent record; absent for a root record. */
  readonly parentId?: string;
  readonly value: T;
}
export interface CompositeRecord<T = unknown> extends BaseRecord<T> {
  readonly childIds: readonly string[];
}
export interface RuntimeValue {
  readonly createdAt: string;
}
export interface RuntimeRecord extends CompositeRecord<RuntimeValue> {}

/** Append-only entries inside one invocation record; no independent record identity. */
export type ProcessRecord = Readonly<{ sequence: number; round: number; occurredAt: string; offsetMs: number } & ({ stage: 'execute'; type: 'start'; input: unknown } | { stage: 'execute' | 'receive'; type: 'return'; output: unknown } | { stage: 'receive'; type: 'return'; resultOf: number } | { stage: 'execute' | 'receive'; type: 'throw'; error: RuntimeErrorValue } | { stage: 'receive'; type: 'continue'; input: unknown; reason: string } | { stage: 'control'; type: 'stop'; error: RuntimeErrorValue })>;

export interface InvocationValue<I = unknown, O = unknown> {
  readonly processes: readonly ProcessRecord[];
  input: I;
  output?: O;
  /** Local process sequence containing the final frozen output; mutually exclusive with output. */
  resultOf?: number;
  error?: RuntimeErrorValue;
}
export interface ExecutionValue<I = unknown, O = unknown> extends InvocationValue<I, O> {
  settings: unknown;
  transcriptRange?: unknown;
  startedAt: string;
}
export interface ExecutionRecord<I = unknown, O = unknown> extends CompositeRecord<ExecutionValue<I, O>> {
  readonly contextId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}
export interface OperationRecord<I = unknown, O = unknown> extends CompositeRecord<InvocationValue<I, O>> {
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
export interface AttemptValue<I = unknown, O = unknown> extends InvocationValue<I, O> {}
/** One invocation of a named action owned by an operation. */
export interface AttemptRecord<I = unknown, O = unknown> extends CompositeRecord<AttemptValue<I, O>> {
  readonly contextId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  readonly operationId: string;
  readonly name: string;
  readonly label: string;
  readonly source: string;
  readonly caller: string;
  readonly callee: string;
}
/** The recorded boundary; its content is independent of record identity and timing. */
export interface EventValue {
  readonly type: 'call' | 'return' | 'throw';
}
/** callId addresses the invocation record, while id identifies this event record. */
export interface EventRecord extends BaseRecord<EventValue> {
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
