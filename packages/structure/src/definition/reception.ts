import type { CallableKind, ReceptionValue, ReceptionDefinition, ReceptionRegistration, ChildContract } from '@weiliang0121/capix-contracts';
import type { ChildContractsOf } from './children.js';

export type DefinitionReceptions<Kind extends CallableKind> = Kind extends 'node' ? never : readonly ReceptionRegistration<ChildContractsOf<Kind>>[];

type SynchronousCheck<Check extends (value: unknown) => unknown> = [Extract<ReturnType<Check>, PromiseLike<unknown>>] extends [never] ? unknown : never;

export function reception<Definition extends ChildContract, Check extends (value: unknown) => unknown>(child: Definition, value: { readonly check: Check } & NoInfer<Omit<ReceptionValue<ReturnType<Check>>, 'check'>> & SynchronousCheck<Check>): ReceptionDefinition<Definition, ReturnType<Check>>;
export function reception<Definition extends ChildContract, Value>(child: Definition, value: ReceptionValue<Value>): object {
  // The witness is type-only. Binding verifies the original objects and registrations.
  return Object.freeze({ child, value });
}
