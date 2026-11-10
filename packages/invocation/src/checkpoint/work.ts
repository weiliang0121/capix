import type { Invocation } from '../invocation/invocation.js';
import type { InvocationContext } from '../context/context.js';
import type { CheckpointReferences, InvocationCheckpointFrame } from '@weiliang0121/capix-checkpoint';
import type { CheckpointCodec, CheckpointContract, CallableKind, Stable } from '@weiliang0121/capix-contracts';
import type { DecodedCheckpointFrame } from './facts.js';
import type { InvocationReceptionBinding } from '../invocation/reception.js';

export interface CheckpointChildBinding {
  readonly kind: CallableKind;
  readonly binding?: CheckpointBinding;
}

export interface CheckpointReferenceSlot {
  readonly cardinality: 'one' | 'many';
  readonly position: number;
}

export interface InvocationCheckpointWork<Input, Output, Context extends InvocationContext<Input, Output>> extends CheckpointContract {
  readonly input: CheckpointCodec<Input>;
  readonly output: CheckpointCodec<Output>;
  readonly children?: readonly CheckpointChildBinding[];
  readonly receptions?: readonly InvocationReceptionBinding[];
  readonly points: Readonly<
    Record<
      string,
      {
        readonly state: CheckpointCodec<any>;
        readonly references?: Readonly<Record<string, CheckpointReferenceSlot>>;
        check?(frame: InvocationCheckpointFrame, state: any, references: CheckpointReferences, decoded: DecodedCheckpointFrame): void;
        execute(context: Context, invocation: Invocation<Input, Output, Context>, state: any, references: CheckpointReferences): Output | Stable<Output> | Promise<Output | Stable<Output>>;
      }
    >
  >;
}
export type CheckpointBinding = Pick<InvocationCheckpointWork<any, any, any>, 'key' | 'version' | 'input' | 'output'>;
