import type { BaseRecord, ProcessRecord, RelationChangeRecord } from './types.js';
import type { RuntimeErrorValue, InvocationFailureFact } from '@weiliang0121/capix-contracts';

export type RecordKind = 'invocation' | 'runtime' | 'runtime-call' | 'execution' | 'operation' | 'attempt' | 'invocation-boundary' | 'transcript' | 'memory' | 'resource' | 'custom';
export interface RecordEntry {
  readonly kind: RecordKind;
  readonly data: BaseRecord;
}
export type RecordMutation = Readonly<{ kind: 'added'; entry: RecordEntry; parent?: Readonly<{ id: string; childId: string }> }> | Readonly<{ kind: 'process-appended'; id: string; process: ProcessRecord }> | Readonly<{ kind: 'relation-appended'; id: string; relation: RelationChangeRecord }> | Readonly<{ kind: 'finished'; id: string; status: 'succeeded' | 'failed'; result: Readonly<{ output?: unknown; resultOf?: number; error?: RuntimeErrorValue; failure?: InvocationFailureFact }> }> | Readonly<{ kind: 'replaced'; entry: RecordEntry }>;
export type RecordChangeEvent = Readonly<{ type: 'record'; recorderId: string; revision: number; occurredAt: string; change: RecordMutation }>;
