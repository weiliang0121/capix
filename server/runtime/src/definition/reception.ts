import type { CallableKind } from '@capix/protocol';
import type { CheckpointValue } from '../checkpoint/contract.js';
import type { ChildContract, ChildContractsOf } from './children.js';

/** Validation never replaces the accepted value; encoding is only for checkpoints. */
export interface ReceptionValue<Value> {
  /** Must finish synchronously; a returned copy is ignored after successful validation. */
  readonly check: (value: unknown) => Value;
  readonly encode: (value: NoInfer<Value>) => CheckpointValue;
  readonly decode: (value: CheckpointValue) => NoInfer<Value>;
}

declare const receptionSignature: unique symbol;

/** A parent's interpretation of one direct child's result, without another execution phase. */
export interface ReceptionDefinition<Definition extends ChildContract, Value> {
  readonly child: Definition;
  readonly value: ReceptionValue<Value>;
  readonly [receptionSignature]: (child: Definition, value: Value) => { readonly child: Definition; readonly value: Value };
}

// Registration is heterogeneous; concrete accept/read sites retain both invariant parameters.
export type ReceptionRegistration<Definition extends ChildContract = ChildContract> = ReceptionDefinition<any, any> & { readonly child: Definition };
export type DefinitionReceptions<Kind extends CallableKind> = Kind extends 'node' ? never : readonly ReceptionRegistration<ChildContractsOf<Kind>>[];

type SynchronousCheck<Check extends (value: unknown) => unknown> = [Extract<ReturnType<Check>, PromiseLike<unknown>>] extends [never] ? unknown : never;

export function reception<Definition extends ChildContract, Check extends (value: unknown) => unknown>(child: Definition, value: { readonly check: Check } & NoInfer<Omit<ReceptionValue<ReturnType<Check>>, 'check'>> & SynchronousCheck<Check>): ReceptionDefinition<Definition, ReturnType<Check>>;
export function reception<Definition extends ChildContract, Value>(child: Definition, value: ReceptionValue<Value>): ReceptionDefinition<Definition, Value> {
  // The witness is type-only. Binding verifies the original objects and registrations.
  return Object.freeze({ child, value }) as ReceptionDefinition<Definition, Value>;
}
