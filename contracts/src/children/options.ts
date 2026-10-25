import type { CallableDelta, CallableOutput } from '../callable/signature.js';
import type { InvocationOutputReceiver } from '../output.js';
import type { OperationOptions, Reception } from '../operation.js';
import type { ReceptionDefinition } from '../checkpoint/reception.js';
import type { ChildContract } from './contract.js';

export interface ChildOptions<Definition extends ChildContract> {
  readonly key?: string;
  readonly output?: InvocationOutputReceiver<CallableOutput<Definition>, CallableDelta<Definition>>;
}

/** Unlabelled reception may transform either outcome into an independently inferred value. */
export type ChildOperationOptions<Definition extends ChildContract> = ChildOptions<Definition> & OperationOptions<CallableOutput<Definition>, unknown, unknown, CallableDelta<Definition>> & { readonly reception?: never };

/** A registered reception fixes the accepted type before either callback is considered. */
export type ChildReceptionOptions<Definition extends ChildContract, Value> = ChildOptions<Definition> & Pick<OperationOptions<CallableOutput<Definition>, unknown, unknown, CallableDelta<Definition>>, 'delta'> & { readonly reception: ReceptionDefinition<Definition, Value> } & ([CallableOutput<Definition>] extends [Value] ? { readonly result?: Reception<CallableOutput<Definition>, unknown, NoInfer<Value>> } : { readonly result: Reception<CallableOutput<Definition>, unknown, NoInfer<Value>> & { readonly succeeded: (value: CallableOutput<Definition>) => NoInfer<Value> | PromiseLike<NoInfer<Value>> } });

/** A saved child handle already fixed its output route at creation. */
export type ChildInvocationOptions<Definition extends ChildContract> = Pick<ChildOperationOptions<Definition>, 'result' | 'reception'> & { readonly delta?: never; readonly output?: never; readonly key?: never };
export type ChildInvocationReceptionOptions<Definition extends ChildContract, Value> = Omit<ChildReceptionOptions<Definition, Value>, 'delta' | 'output' | 'key'> & { readonly delta?: never; readonly output?: never; readonly key?: never };
