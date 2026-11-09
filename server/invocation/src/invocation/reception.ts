import type { CheckpointCodec } from '@weiliang0121/capix-contracts';

/** One fixed contract in a parent's registration, shared by live and restored relations. */
export interface InvocationReceptionBinding {
  readonly position: number;
  readonly childPosition: number;
  readonly check: (value: unknown) => void;
  readonly codec: CheckpointCodec<any>;
}
