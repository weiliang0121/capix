import { FactType } from '@weiliang0121/capix-changes';
import type { InvocationOrigin, Stable } from '@weiliang0121/capix-contracts';
import type { MemoryContent } from './memory.js';

export interface MemoryEvent<Metadata = never> {
  readonly type: 'memory';
  readonly memoriesId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly origin?: InvocationOrigin;
  readonly change: {
    readonly action: 'create' | 'update';
    readonly memoryId: string;
    readonly value: Stable<MemoryContent<Metadata>>;
    readonly reason?: string;
  };
}

/** Exact producer vocabulary; adapters explicitly project metadata for their consumers. */
export const MemoryFacts = new FactType<MemoryEvent<unknown>>('memory');
