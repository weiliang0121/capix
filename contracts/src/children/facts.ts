import type { CallableInput, CallableOutput } from '../callable/signature.js';
import type { InvocationFailureFact, RuntimeErrorValue } from '../diagnostic.js';
import type { ReceptionDefinition } from '../checkpoint/reception.js';
import type { ChildReference } from './reference.js';
import type { ChildContract } from './contract.js';

export type ChildReturnFact<Output> = { readonly status: 'succeeded'; readonly output: Output } | { readonly status: 'failed'; readonly diagnostic: RuntimeErrorValue; readonly failure?: InvocationFailureFact } | { readonly status: 'cancelled'; readonly diagnostic: RuntimeErrorValue };
export interface ChildFact<Definition = unknown> {
  readonly ref: ChildReference<Definition>;
  readonly key?: string;
  readonly parentRound: 1 | 2;
  readonly order: number;
  readonly input: CallableInput<Definition>;
  readonly returned: ChildReturnFact<CallableOutput<Definition>> | undefined;
  readonly reception: { readonly status: 'pending' | 'receiving' } | { readonly status: 'accepted' | 'handled'; readonly value: unknown } | { readonly status: 'failed'; readonly diagnostic: RuntimeErrorValue; readonly failure?: InvocationFailureFact };
  readonly progress?: { readonly round: 1 | 2; readonly currentInput: CallableInput<Definition>; readonly phase: 'execute' | 'receive' | 'handling' };
}

export interface ChildFacts {
  accepted<Definition extends ChildContract, Value>(reference: ChildReference<Definition>, reception: ReceptionDefinition<NoInfer<Definition>, Value>): Value;
  handled<Definition extends ChildContract, Value>(reference: ChildReference<Definition>, reception: ReceptionDefinition<NoInfer<Definition>, Value>): Value;
  get<Definition extends ChildContract>(reference: ChildReference<Definition>): ChildFact<Definition>;
  require<Definition extends ChildContract>(definition: Definition, reference: ChildReference): ChildFact<Definition>;
  list<Definition extends ChildContract>(definition: Definition, query?: { readonly parentRound?: 1 | 2 }): readonly ChildFact<Definition>[];
  requireUnique<Definition extends ChildContract>(definition: Definition, query: { readonly parentRound: 1 | 2 }): ChildFact<Definition>;
  values(): readonly ChildFact[];
}
