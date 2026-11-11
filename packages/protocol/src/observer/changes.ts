import type { TranscriptEvent, MemoryChangeEvent } from '../content/changes.js';
import type { RecordChangeEvent } from '../recording/changes.js';
import type { InvocationEvent } from '../invocation/changes.js';

/** Current Observer environment's assembled change sources; not a universal kernel event set. */
export type ObserverChange = TranscriptEvent | MemoryChangeEvent | RecordChangeEvent | InvocationEvent;
