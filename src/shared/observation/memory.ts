import type { Message } from '../transcript/message.js';
import type { MemoryRecord } from '../records/memory.js';

export interface MemoryObservation {
  readonly items: readonly {
    id: string;
    topic: string;
    content: string;
    sources: readonly { index: number; message: Readonly<Message> }[];
    records: readonly MemoryRecord[];
  }[];
}
