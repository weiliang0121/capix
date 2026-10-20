import type { RecordingArchiveOrigin } from '../observer/archive.js';
import type { InvocationFailureFact, RuntimeErrorValue } from '../invocation/errors.js';
import type { CallableKind } from '../invocation/types.js';
import type { TranscriptRecord } from './transcript.js';
import type { MemoryRecord } from './memory.js';
import type { ResourceRecord } from './resource.js';
import type { InvocationRelationIdentity } from '../invocation/types.js';
export { invocationProcessStages, invocationProcessActions } from '../invocation/types.js';

/** Common record shape; concrete records define their own relations and body. */
export interface BaseRecord<Value = unknown> {
  readonly id: string;
  /** Direct parent record; absent for a root record. */
  readonly parentId?: string;
  readonly value: Value;
}
export interface CompositeRecord<Value = unknown> extends BaseRecord<Value> {
  readonly childIds: readonly string[];
}
export interface RecordingRootValue {
  readonly createdAt: string;
}
/** One recording installation's cross-call root; not a BoundRuntime identity. */
export interface RecordingRootRecord extends CompositeRecord<RecordingRootValue> {}

/** Append-only entries inside one invocation record; no independent record identity. */
export type ProcessRecord = Readonly<{ sequence: number; eventSequence: number; round: number; occurredAt: string; offsetMs: number } & ({ stage: 'execute'; type: 'start'; input: unknown } | { stage: 'execute' | 'receive' | 'handling'; type: 'return'; output: unknown } | { stage: 'receive'; type: 'return'; resultOf: number } | { stage: 'execute' | 'receive' | 'handling'; type: 'throw'; error: RuntimeErrorValue; failure?: InvocationFailureFact } | { stage: 'receive' | 'handling'; type: 'continue'; input: unknown; reason: string } | { stage: 'handling'; type: 'start' | 'unhandled'; error: RuntimeErrorValue; failure?: InvocationFailureFact } | { stage: 'control'; type: 'stop'; error: RuntimeErrorValue; failure?: InvocationFailureFact })>;

export type RecordedInvocationResult = Readonly<{ status: 'succeeded'; output: unknown } | { status: 'failed'; error: RuntimeErrorValue; failure?: InvocationFailureFact }>;
export type RecordedRelationChange = Readonly<{ kind: 'attached' } | { kind: 'returned'; result: RecordedInvocationResult } | { kind: 'receiving' } | { kind: 'accepted'; output: unknown } | { kind: 'failed'; source: 'work' | 'observation'; error: RuntimeErrorValue; failure?: InvocationFailureFact }>;
/** Parent-owned relation history; separate from its own execution/acceptance processes. */
export interface RelationChangeRecord {
  readonly identity: InvocationRelationIdentity;
  readonly eventSequence: number;
  readonly occurredAt: string;
  readonly offsetMs: number;
  /** Present once this local child has actually started and acquired a record. */
  readonly childId?: string;
  readonly change: RecordedRelationChange;
}
export interface InvocationValue<Input = unknown, Output = unknown> {
  readonly processes: readonly ProcessRecord[];
  readonly relationChanges: readonly RelationChangeRecord[];
  input: Input;
  output?: Output;
  /** Local process sequence containing the final frozen output; mutually exclusive with output. */
  resultOf?: number;
  error?: RuntimeErrorValue;
  failure?: InvocationFailureFact;
}
/** One R invocation, distinct from the recording installation's cross-call root. */
export interface RuntimeCallValue<Input = unknown, Output = unknown> extends InvocationValue<Input, Output> {
  readonly startedAt: string;
}
export interface RuntimeCallRecord<Input = unknown, Output = unknown> extends CompositeRecord<RuntimeCallValue<Input, Output>> {
  /** Identity of this invocation's Context. */
  readonly contextId: string;
  /** Stable identity of the BoundRuntime reused across invocations. */
  readonly runtimeInstanceId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}
export interface ExecutionValue<Input = unknown, Output = unknown> extends InvocationValue<Input, Output> {
  startedAt: string;
}
export interface ExecutionRecord<Input = unknown, Output = unknown> extends CompositeRecord<ExecutionValue<Input, Output>> {
  readonly contextId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}
export interface OperationRecord<Input = unknown, Output = unknown> extends CompositeRecord<InvocationValue<Input, Output>> {
  readonly contextId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  /** Ancestor execution record identity. */
  readonly executionId: string;
  /** Stable identity of the BoundOperation reused across invocations. */
  readonly operationInstanceId: string;
  /** Direct parent operation record identity, when nested under an operation. */
  readonly parentOperationId?: string;
  readonly operation: string;
  readonly label: string;
  readonly source: string;
  /** Declared participant names, not record identities or a closed capability registry. */
  readonly caller: string;
  readonly callee: string;
}
export interface AttemptValue<Input = unknown, Output = unknown> extends InvocationValue<Input, Output> {}
/** One invocation of a named action owned by an operation. */
export interface AttemptRecord<Input = unknown, Output = unknown> extends CompositeRecord<AttemptValue<Input, Output>> {
  readonly contextId: string;
  readonly status: 'running' | 'succeeded' | 'failed';
  /** Direct parent operation record identity. */
  readonly operationId: string;
  readonly name: string;
  readonly label: string;
  readonly source: string;
  /** Declared participant names, not record identities or a closed capability registry. */
  readonly caller: string;
  readonly callee: string;
}
/** The recorded boundary; its content is independent of record identity and timing. */
export interface InvocationBoundaryValue {
  readonly type: 'call' | 'return' | 'throw';
  /** Describes the call's work outcome, not its eventual delivery to a parent. */
  readonly scope: 'work';
}
/** callId addresses the invocation record, while id identifies this invocation boundary record. */
export interface InvocationBoundaryRecord extends BaseRecord<InvocationBoundaryValue> {
  /** R has its own timing range; E descendants share their execution range. */
  readonly scopeId: string;
  readonly executionId?: string;
  readonly callId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly offsetMs: number;
}
/** One E invocation's record subtree, parent R invocation record and recorded work boundaries. */
export interface LegacyExecutionRecordSnapshot {
  readonly archive?: RecordingArchiveOrigin;
  runtimeCall: RuntimeCallRecord;
  runtimeEvents: InvocationBoundaryRecord[];
  execution: ExecutionRecord;
  operations: OperationRecord[];
  attempts: AttemptRecord[];
  /** Existing wire field; these are invocation boundary records, not system change events. */
  events: InvocationBoundaryRecord[];
  resources: ResourceRecord[];
}

/** One actual Callable invocation; structure and business roles do not determine its parent. */
export interface CallableValue<Input = unknown, Output = unknown> extends InvocationValue<Input, Output> {
  /** New calls always supply this; an interrupted legacy carrier may have no observed start. */
  readonly startedAt?: string;
}
export interface CallableRecord<Input = unknown, Output = unknown> extends CompositeRecord<CallableValue<Input, Output>> {
  readonly contextId: string;
  readonly structureKind: CallableKind;
  readonly structureId?: string;
  readonly name?: string;
  readonly label?: string;
  readonly source?: string;
  readonly callee?: string;
  /** Host interpretation only; never a kernel dispatch or recovery contract. */
  readonly role?: string;
  readonly status: 'running' | 'succeeded' | 'failed';
}
/** A service-selected task subtree. The task role is independent of structural kind. */
export interface ExecutionRecordSnapshot {
  readonly archive?: RecordingArchiveOrigin;
  readonly execution: CallableRecord;
  readonly calls: readonly CallableRecord[];
  readonly rootCall?: CallableRecord;
  /** Complete root-to-parent path between rootCall and execution; excludes both endpoints. */
  readonly ancestors?: readonly CallableRecord[];
  readonly boundaries: readonly InvocationBoundaryRecord[];
  readonly transcripts: readonly TranscriptRecord[];
  readonly memories: readonly MemoryRecord[];
  readonly resources: readonly ResourceRecord[];
}
