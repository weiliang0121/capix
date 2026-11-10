import type { Stable } from '../value.js';
import type { CheckpointValue } from './codec.js';
import type { ChildContract } from '../children/contract.js';
import type { CallableShape } from '../callable/signature.js';

/** Validation never replaces the accepted value; encoding is only for checkpoints. */
export interface ReceptionValue<Value> {
  /** Must finish synchronously; a returned copy is ignored after successful validation. */
  readonly check: (value: unknown) => Value | Stable<Value>;
  readonly encode: (value: NoInfer<Stable<Value>>) => CheckpointValue;
  readonly decode: (value: CheckpointValue) => NoInfer<Value> | NoInfer<Stable<Value>>;
}

declare const receptionSignature: unique symbol;

/** A parent's interpretation of one direct child's result, without another execution phase. */
interface ReceptionContract<Definition extends ChildContract, Value> {
  readonly child: Definition;
  readonly value: ReceptionValue<Value>;
  readonly [receptionSignature]: (child: Definition, value: Value) => { readonly child: Definition; readonly value: Value };
}

/** Assembly capabilities do not change the child contract associated with a reception. */
export type ReceptionDefinition<Definition extends ChildContract, Value> = ReceptionContract<CallableShape<Definition>, Value>;

// Registration is heterogeneous; concrete accept/read sites retain both invariant parameters.
export type ReceptionRegistration<Definition extends ChildContract = ChildContract> = ReceptionContract<any, any> & { readonly child: CallableShape<Definition> };
