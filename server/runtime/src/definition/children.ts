import type { ExecutionDefinition } from './execution.js';
import type { OperationDefinition } from './operation.js';
import type { AttemptDefinition } from './attempt.js';
import type { DefinitionContract, DefinitionInput, DefinitionOutput, DefinitionDelta } from './signature.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import type { ChildEntry } from './entry.js';
import type { InvocationFailureFact, RuntimeErrorValue, InvocationLevel } from '@capix/protocol';
import type { ChildLevel } from './level.js';

// Heterogeneous storage erases IO; all public lookup and call sites retain the concrete definition.
export type ChildDefinition = ExecutionDefinition<any, any, any, any, any> | OperationDefinition<any, any, any, any, any> | AttemptDefinition<any, any, any, any, any>;
export type ChildrenOf<Level extends InvocationLevel> = Extract<ChildDefinition, { readonly level: ChildLevel<Level> }>;
/** Calls and facts need a target signature, never the target's complete declaration tree. */
// Input is erased only at this heterogeneous upper bound; concrete call sites retain their Definition.
export type ChildContract = DefinitionContract<'execution', any> | DefinitionContract<'operation', any> | DefinitionContract<'attempt', any>;
export type ChildContractsOf<Level extends InvocationLevel> = Extract<ChildContract, { readonly level: ChildLevel<Level> }>;
export type DefinitionChildren<Level extends InvocationLevel> = Level extends 'attempt' ? { readonly children?: never } : { readonly children: readonly ChildrenOf<Level>[] };
export type { DefinitionContract, DefinitionInput, DefinitionOutput, DefinitionDelta } from './signature.js';

declare const childReferenceSignature: unique symbol;
/** Certified by this parent activity; the opaque identity does not grant action rights. */
export interface ChildReference<Definition = unknown> {
  readonly [childReferenceSignature]: Definition;
}

export interface ChildCall<Definition extends ChildContract> {
  readonly ref: ChildReference<Definition>;
  readonly key?: string;
  run(): Promise<DefinitionOutput<Definition>>;
  accept(): Promise<DefinitionOutput<Definition>>;
  accept<Value>(receive: (output: DefinitionOutput<Definition>) => Value | Promise<Value>): Promise<Value>;
}

export type ChildReturnFact<Output> = { readonly status: 'succeeded'; readonly output: Output } | { readonly status: 'failed'; readonly diagnostic: RuntimeErrorValue; readonly failure?: InvocationFailureFact } | { readonly status: 'cancelled'; readonly diagnostic: RuntimeErrorValue };
export interface ChildFact<Definition = unknown> {
  readonly ref: ChildReference<Definition>;
  readonly key?: string;
  readonly parentRound: 1 | 2;
  readonly order: number;
  readonly input: DefinitionInput<Definition>;
  readonly returned: ChildReturnFact<DefinitionOutput<Definition>> | undefined;
  readonly reception: { readonly status: 'pending' | 'receiving' } | { readonly status: 'accepted'; readonly value: unknown } | { readonly status: 'failed'; readonly diagnostic: RuntimeErrorValue; readonly failure?: InvocationFailureFact };
  readonly progress?: { readonly round: 1 | 2; readonly currentInput: DefinitionInput<Definition>; readonly phase: 'execute' | 'receive' | 'handling' };
}

export interface ChildFacts {
  get<Definition extends ChildContract>(reference: ChildReference<Definition>): ChildFact<Definition>;
  require<Definition extends ChildContract>(definition: Definition, reference: ChildReference): ChildFact<Definition>;
  list<Definition extends ChildContract>(definition: Definition, query?: { readonly parentRound?: 1 | 2 }): readonly ChildFact<Definition>[];
  requireUnique<Definition extends ChildContract>(definition: Definition, query: { readonly parentRound: 1 | 2 }): ChildFact<Definition>;
  values(): readonly ChildFact[];
}

export interface ChildOptions<Definition extends ChildContract> {
  readonly key?: string;
  readonly output?: InvocationOutputReceiver<DefinitionOutput<Definition>, DefinitionDelta<Definition>>;
}

export interface ChildCalls<Allowed extends ChildContract = ChildContract> {
  create<Definition extends Allowed>(definition: Definition, input: NoInfer<DefinitionInput<Definition>>, options?: ChildOptions<Definition>): ChildCall<Definition>;
  entry<Definition extends Allowed, Input>(entry: ChildEntry<Definition, Input>, input: NoInfer<Input>, options?: ChildOptions<Definition>): ChildCall<Definition>;
  open<Definition extends ChildContract>(reference: ChildReference<Definition>): ChildCall<Definition>;
  readonly facts: ChildFacts;
}
export interface ResumeChildCalls<Allowed extends ChildContract = ChildContract> extends ChildCalls<Allowed> {
  resume<Definition extends Allowed>(reference: ChildReference<Definition>): ChildCall<Definition>;
}
