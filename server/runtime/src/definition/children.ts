import type { ExecutionDefinition } from './execution.js';
import type { OperationDefinition } from './operation.js';
import type { AttemptDefinition } from './attempt.js';
import type { invocationSignature, InvocationSignature } from './signature.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import type { InvocationEntry } from './entry.js';
import type { InvocationFailureFact, RuntimeErrorValue, InvocationLevel } from '@capix/protocol';
import type { ChildLevel } from './level.js';

// Heterogeneous storage erases IO; all public lookup and call sites retain the concrete definition.
export type ChildDefinition = ExecutionDefinition<any, any, any, any, any> | OperationDefinition<any, any, any, any, any> | AttemptDefinition<any, any, any, any, any>;
export type ChildrenOf<Level extends InvocationLevel> = Extract<ChildDefinition, { readonly level: ChildLevel<Level> }>;
type Signature<Definition> = Definition extends { readonly [invocationSignature]?: infer S } ? NonNullable<S> : InvocationSignature<unknown, unknown, unknown>;
export type DefinitionInput<Definition> = Signature<Definition> extends { readonly input: infer Input } ? Input : unknown;
export type DefinitionOutput<Definition> = Signature<Definition> extends { readonly output: infer Output } ? Output : unknown;

export type DefinitionDelta<Definition> = Signature<Definition> extends { readonly delta: infer Delta } ? Delta : never;

declare const childReferenceSignature: unique symbol;
/** Certified by this parent activity; the opaque identity does not grant action rights. */
export interface ChildReference<Definition = unknown> {
  readonly [childReferenceSignature]: Definition;
}

export interface ChildCall<Definition extends ChildDefinition> {
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
  get<Definition extends ChildDefinition>(reference: ChildReference<Definition>): ChildFact<Definition>;
  require<Definition extends ChildDefinition>(definition: Definition, reference: ChildReference): ChildFact<Definition>;
  list<Definition extends ChildDefinition>(definition: Definition, query?: { readonly parentRound?: 1 | 2 }): readonly ChildFact<Definition>[];
  requireUnique<Definition extends ChildDefinition>(definition: Definition, query: { readonly parentRound: 1 | 2 }): ChildFact<Definition>;
  values(): readonly ChildFact[];
}

export interface ChildOptions<Definition extends ChildDefinition> {
  readonly key?: string;
  readonly output?: InvocationOutputReceiver<DefinitionOutput<Definition>, DefinitionDelta<Definition>>;
}

export interface ChildCalls<Allowed extends ChildDefinition = ChildDefinition> {
  create<Definition extends Allowed>(definition: Definition, input: NoInfer<DefinitionInput<Definition>>, options?: ChildOptions<Definition>): ChildCall<Definition>;
  entry<Definition extends Allowed, Input>(entry: InvocationEntry<Definition, Input>, input: NoInfer<Input>, options?: ChildOptions<Definition>): ChildCall<Definition>;
  open<Definition extends ChildDefinition>(reference: ChildReference<Definition>): ChildCall<Definition>;
  readonly facts: ChildFacts;
}
export interface ResumeChildCalls<Allowed extends ChildDefinition = ChildDefinition> extends ChildCalls<Allowed> {
  resume<Definition extends Allowed>(reference: ChildReference<Definition>): ChildCall<Definition>;
}
