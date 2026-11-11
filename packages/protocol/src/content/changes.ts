import type { Message } from './message.js';
import type { MemoryContent, MemoryResultSource } from './memory.js';
import type { InvocationOrigin } from '@weiliang0121/capix-contracts';

export type TranscriptEvent = Readonly<{ type: 'transcript'; transcriptId: string; revision: number; occurredAt: string; origin?: InvocationOrigin; change: Readonly<{ kind: 'messages-appended'; start: number; messages: readonly Readonly<Message>[] }> | Readonly<{ kind: 'segment-started'; previousStart: number; start: number; end: number }> }>;
export type MemoryEvent = Readonly<{ type: 'memory'; memoriesId: string; sequence: number; occurredAt: string; origin?: InvocationOrigin; change: Readonly<{ action: 'create' | 'update'; memoryId: string; explanation: string; sourceIndexes: readonly number[]; sourceResults?: readonly MemoryResultSource[]; result: MemoryContent }> }>;
