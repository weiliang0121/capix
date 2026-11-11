import type { MemoryMutation } from './change.js';
import type { MemoryBasis, MemoryContentContractIdentity } from './memory.js';

/** An actual applying operation, including the exact content contract and original basis. */
export interface MemoryFixedApply<Metadata = never> {
  readonly contract: { readonly key: 'memories.apply'; readonly version: 2 };
  readonly contentContract: MemoryContentContractIdentity;
  readonly operation: { readonly contextId: string };
  readonly memoriesId: string;
  readonly command: { readonly position: string; readonly changes: readonly MemoryMutation<Metadata>[] };
  readonly expected?: MemoryBasis;
}

export interface MemoryApplyReceipt {
  readonly memoriesId: string;
  readonly startSequence: number;
  readonly sequence: number;
  /** Sparse, ordered correspondence: equal updates have no entry. */
  readonly changes: readonly { readonly commandIndex: number; readonly memoryId: string }[];
}

export interface MemoryApplyState<Metadata = never> {
  readonly request: MemoryFixedApply<Metadata>;
  readonly receipt: MemoryApplyReceipt;
}
