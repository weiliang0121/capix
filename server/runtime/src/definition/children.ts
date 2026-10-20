import type { GroupDefinition } from './group.js';
import type { NodeDefinition } from './node.js';
import type { DefinitionContract, DefinitionInput, DefinitionOutput, DefinitionDelta } from './signature.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import type { ChildEntry } from './entry.js';
import type { InvocationFailureFact, RuntimeErrorValue, CallableKind } from '@capix/protocol';
import type { ReceptionDefinition } from './reception.js';
import type { ChildKind } from './kind.js';

// Heterogeneous storage erases IO; call sites retain the concrete definition.
export type ChildDefinition = GroupDefinition<any, any, any, any, any> | NodeDefinition<any, any, any, any, any>;
export type ChildrenOf<Kind extends CallableKind> = [ChildKind<Kind>] extends [never] ? never : ChildDefinition;
/** Calls and facts consume the signature of the same registered definition object. */
export type ChildContract = DefinitionContract<'group', any> | DefinitionContract<'node', any>;
export type ChildContractsOf<Kind extends CallableKind> = [ChildKind<Kind>] extends [never] ? never : ChildContract;
export type DefinitionMembers<Kind extends CallableKind> = Kind extends 'node' ? { readonly members?: never } : { readonly members: readonly ChildrenOf<Kind>[] };
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
  accept<Value>(reception: ReceptionDefinition<Definition, Value>, receive: (output: DefinitionOutput<Definition>) => NoInfer<Value> | Promise<NoInfer<Value>>): Promise<Value>;
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
  accepted<Definition extends ChildContract, Value>(reference: ChildReference<Definition>, reception: ReceptionDefinition<NoInfer<Definition>, Value>): Value;
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
