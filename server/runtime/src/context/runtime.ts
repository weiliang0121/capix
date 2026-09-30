import type { Transcript } from '../transcript/transcript.js';
import type { Memories } from '../memory/memories.js';
import type { SelectionUsage } from '../transcript/usage.js';

/** Live contents of a Runtime data scope. Each owner still governs its own changes. */
export class RuntimeContext {
  constructor(
    readonly transcript: Transcript,
    readonly memories: Memories,
    readonly selectionUsage: SelectionUsage,
  ) {}
}
