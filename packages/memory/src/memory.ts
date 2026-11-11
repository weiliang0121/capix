import type { Stable } from '@weiliang0121/capix-contracts';

/** A continuing compressed summary. Metadata belongs to the author's content contract. */
export interface MemoryContent<Metadata = never> {
  readonly content: string;
  readonly metadata?: Metadata;
}

/** Immutable material, rather than a second owner with a live write lifecycle. */
export interface MemoryItem<Metadata = never> {
  readonly id: string;
  readonly value: MemoryContent<Metadata>;
}

export interface MemoryBasis {
  readonly memoriesId: string;
  readonly sequence: number;
}

export type MemoryRead<Metadata = never> = Stable<MemoryItem<Metadata> & { readonly basis: MemoryBasis }>;

export interface MemorySnapshot<Metadata = never> {
  readonly basis: MemoryBasis;
  readonly items: readonly MemoryItem<Metadata>[];
}

export interface MemoryApplication<Metadata = never> {
  readonly before: MemoryBasis;
  readonly after: MemoryBasis;
  readonly changed: readonly MemoryItem<Metadata>[];
}

export interface MemoryContentContractIdentity {
  readonly key: string;
  readonly version: number;
}

/** check validates the entire fixed content synchronously; its return never replaces content. */
export interface MemoryContentContract<Metadata = never> extends MemoryContentContractIdentity {
  readonly check?: (value: Stable<MemoryContent<Metadata>>) => void;
}
