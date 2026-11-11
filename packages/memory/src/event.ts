import { FactType } from '@weiliang0121/capix-changes';
import type { MemoryEvent } from '@weiliang0121/capix-protocol';

export type { MemoryEvent } from '@weiliang0121/capix-protocol';

/** Memory change interpretation belongs to the producer and its explicit adapters. */
export const MemoryFacts = new FactType<MemoryEvent>('memory');
