import type { TranscriptEvent, MemoryEvent } from '../content/changes.js';
import type { RecordChangeEvent } from '../recording/changes.js';
import type { InvocationEvent } from '../invocation/changes.js';

/** Current Observer environment's assembled change sources; not a universal kernel event set. */
export type ObserverChange = TranscriptEvent | MemoryEvent | RecordChangeEvent | InvocationEvent;
