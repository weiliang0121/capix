import type { Invocation } from '../invocation/invocation.js';
import type { InvocationContext } from '../context/context.js';
import type { CheckpointCodec, CheckpointContract, InvocationCheckpointFrame } from './contract.js';

export interface InvocationCheckpointWork<Input, Output, Context extends InvocationContext<Input, Output>> extends CheckpointContract {
  readonly input: CheckpointCodec<Input>;
  readonly output: CheckpointCodec<Output>;
  readonly points: Readonly<
    Record<
      string,
      {
        readonly state: CheckpointCodec<any>;
        check?(frame: InvocationCheckpointFrame, state: any): void;
        execute(context: Context, invocation: Invocation<Input, Output, Context>, state: any): Output | Promise<Output>;
      }
    >
  >;
}
export type CheckpointBinding = Pick<InvocationCheckpointWork<any, any, any>, 'key' | 'version' | 'input' | 'output'>;
