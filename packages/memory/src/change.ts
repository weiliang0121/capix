import type { MemoryContent } from './memory.js';

/** A proposal. Optional reasoning is operation data, not part of the saved summary. */
export type MemoryMutation<Metadata = never> = ({ readonly action: 'create' } | { readonly action: 'update'; readonly memoryId: string }) & { readonly value: MemoryContent<Metadata>; readonly reason?: string };
