import type { MemoryChange } from './change.js';

/** A fixed batch belongs to one actual applying invocation, not to a model proposal ID. */
export interface MemoryFixedApply {
  readonly contract: { readonly key: 'memories.apply'; readonly version: 1 };
  readonly operation: { readonly contextId: string; readonly position: string };
  readonly memoriesId: string;
  readonly changes: readonly MemoryChange[];
}

export interface MemoryApplyReceipt {
  readonly memoriesId: string;
  readonly startSequence: number;
  readonly sequence: number;
  readonly memoryIds: readonly string[];
}

export interface MemoryApplyState {
  readonly request: MemoryFixedApply;
  readonly receipt: MemoryApplyReceipt;
}
