import type { Message } from './message.js';
import type { MemoryViewValue } from './memory.js';
import type { InvocationOrigin } from '@weiliang0121/capix-contracts';

export type TranscriptEvent = Readonly<{ type: 'transcript'; transcriptId: string; revision: number; occurredAt: string; origin?: InvocationOrigin; change: Readonly<{ kind: 'messages-appended'; start: number; messages: readonly Readonly<Message>[] }> | Readonly<{ kind: 'segment-started'; previousStart: number; start: number; end: number }> }>;
/** Wire display change: deliberately excludes domain metadata and carries no recovery authority. */
export type MemoryChangeEvent = Readonly<{ type: 'memory'; memoriesId: string; sequence: number; occurredAt: string; origin?: InvocationOrigin; change: Readonly<{ action: 'create' | 'update'; memoryId: string; value: MemoryViewValue; reason?: string }> }>;
