import type { Message } from './message.js';
import type { MemoryContent } from './memory.js';
import type { BaseRecord, ProcessRecord, RelationChangeRecord } from './records.js';
import type { RuntimeErrorValue, InvocationFailureFact } from './errors.js';
import type { InvocationLevel, InvocationProcessStage, InvocationProcessAction, InvocationRelationIdentity, InvocationRelationPhase } from './invocation.js';

export interface RuntimeOrigin {
  readonly contextId: string;
}
export type TranscriptEvent = Readonly<{ type: 'transcript'; transcriptId: string; revision: number; occurredAt: string; origin?: RuntimeOrigin; change: Readonly<{ kind: 'messages-appended'; start: number; messages: readonly Readonly<Message>[] }> | Readonly<{ kind: 'segment-started'; previousStart: number; start: number; end: number }> }>;
export type MemoryEvent = Readonly<{ type: 'memory'; memoriesId: string; sequence: number; occurredAt: string; origin?: RuntimeOrigin; change: Readonly<{ action: 'create' | 'update'; memoryId: string; explanation: string; sourceIndexes: readonly number[]; result: MemoryContent }> }>;
export type RecordKind = 'runtime' | 'runtime-call' | 'execution' | 'operation' | 'attempt' | 'invocation-boundary' | 'transcript' | 'memory' | 'resource' | 'custom';
export interface RecordEntry {
  readonly kind: RecordKind;
  readonly data: BaseRecord;
}
export type RecordMutation = Readonly<{ kind: 'added'; entry: RecordEntry; parent?: Readonly<{ id: string; childId: string }> }> | Readonly<{ kind: 'process-appended'; id: string; process: ProcessRecord }> | Readonly<{ kind: 'relation-appended'; id: string; relation: RelationChangeRecord }> | Readonly<{ kind: 'finished'; id: string; status: 'succeeded' | 'failed'; result: Readonly<{ output?: unknown; resultOf?: number; error?: RuntimeErrorValue; failure?: InvocationFailureFact }> }> | Readonly<{ kind: 'replaced'; entry: RecordEntry }>;
export type RecordChangeEvent = Readonly<{ type: 'record'; recorderId: string; revision: number; occurredAt: string; change: RecordMutation }>;
/** Live call progress metadata, independent of recording or arbitrary IO serialization. */
export type InvocationEvent = Readonly<{ type: 'invocation'; contextId: string; parentContextId?: string; level: InvocationLevel; sequence: number; occurredAt: string; change: Readonly<{ kind: 'started' }> | Readonly<{ kind: 'entry'; target: 'execution'; instanceId: string; key?: string; stage: 'accept' | 'notification' | 'admit' | 'capture'; status: 'accepted' | 'failed'; error?: RuntimeErrorValue }> | Readonly<{ kind: 'process'; processSequence: number; round: number; stage: InvocationProcessStage; action: InvocationProcessAction }> | Readonly<{ kind: 'relation'; identity: InvocationRelationIdentity; phase: InvocationRelationPhase; status?: 'succeeded' | 'failed'; failure?: InvocationFailureFact }> | Readonly<{ kind: 'finished'; status: 'succeeded' | 'failed' }> }>;
export type RuntimeChange = TranscriptEvent | MemoryEvent | RecordChangeEvent | InvocationEvent;
