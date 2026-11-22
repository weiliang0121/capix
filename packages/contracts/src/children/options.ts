import type { Stable } from '../value.js';
import type { CallableDelta, CallableOutput } from '../callable/signature.js';
import type { InvocationOutputReceiver } from '../output.js';
import type { OperationOptions } from '../operation.js';
import type { ReceptionDefinition } from '../checkpoint/reception.js';
import type { ChildContract } from './contract.js';

declare const childReceptionSignature: unique symbol;

/** Ephemeral authority issued to one direct-child result callback by its parent. */
export type ChildReceptionPermit = symbol & { readonly [childReceptionSignature]: true };

export interface ChildResultReception<Value, Result> {
  readonly succeeded?: (value: Value, permit: ChildReceptionPermit) => Result | PromiseLike<Result>;
  readonly failed?: (failure: unknown, permit: ChildReceptionPermit) => Result | PromiseLike<Result>;
}

export interface ChildOptions<Definition extends ChildContract> {
  readonly key?: string;
  readonly output?: InvocationOutputReceiver<CallableOutput<Definition>, CallableDelta<Definition>>;
}

/** Unlabelled reception may transform either outcome into an independently inferred value. */
export type ChildOperationOptions<Definition extends ChildContract> = ChildOptions<Definition> & Pick<OperationOptions<Stable<CallableOutput<Definition>>, unknown, unknown, Stable<CallableDelta<Definition>>>, 'delta'> & { readonly reception?: never; readonly result?: ChildResultReception<Stable<CallableOutput<Definition>>, unknown> };

/** A registered reception fixes the accepted type before either callback is considered. */
export type ChildReceptionOptions<Definition extends ChildContract, Value> = ChildOptions<Definition> & Pick<OperationOptions<Stable<CallableOutput<Definition>>, unknown, unknown, Stable<CallableDelta<Definition>>>, 'delta'> & { readonly reception: ReceptionDefinition<Definition, Value> } & ([Stable<CallableOutput<Definition>>] extends [Value | Stable<Value>] ? { readonly result?: ChildResultReception<Stable<CallableOutput<Definition>>, NoInfer<Value> | NoInfer<Stable<Value>>> } : { readonly result: ChildResultReception<Stable<CallableOutput<Definition>>, NoInfer<Value> | NoInfer<Stable<Value>>> & { readonly succeeded: (value: Stable<CallableOutput<Definition>>, permit: ChildReceptionPermit) => NoInfer<Value> | NoInfer<Stable<Value>> | PromiseLike<NoInfer<Value> | NoInfer<Stable<Value>>> } });

/** A saved child handle already fixed its output route at creation. */
export type ChildInvocationOptions<Definition extends ChildContract> = Pick<ChildOperationOptions<Definition>, 'result' | 'reception'> & { readonly delta?: never; readonly output?: never; readonly key?: never };
export type ChildInvocationReceptionOptions<Definition extends ChildContract, Value> = Omit<ChildReceptionOptions<Definition, Value>, 'delta' | 'output' | 'key'> & { readonly delta?: never; readonly output?: never; readonly key?: never };
