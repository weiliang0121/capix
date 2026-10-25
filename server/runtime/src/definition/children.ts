import type { CallableStructure } from '../structure/callable.js';
import type { Composite } from './composition.js';
import type { CallableContract, CallableInput, CallableOutput, CallableDelta, CallableShape } from './signature.js';
import type { InvocationOutputReceiver } from '../output/contract.js';
import type { ChildEntry } from './entry.js';
import type { InvocationFailureFact, RuntimeErrorValue, CallableKind } from '@capix/protocol';
import type { ReceptionDefinition } from './reception.js';
import type { ChildKind } from './kind.js';
import type { OperationOptions, OperationResult, Reception } from '../operation/contract.js';

// Heterogeneous storage erases IO; call sites retain the concrete definition.
export type ChildCallable = (CallableStructure<'group'> & Composite) | (CallableStructure<'node'> & { readonly members?: never });
export type ChildrenOf<Kind extends CallableKind> = [ChildKind<Kind>] extends [never] ? never : ChildCallable;
/** Calls and facts consume the signature of the same registered definition object. */
export type ChildContract = CallableContract<'group', any> | CallableContract<'node', any>;
export type ChildContractsOf<Kind extends CallableKind> = [ChildKind<Kind>] extends [never] ? never : ChildContract;
export type CallableMembers<Kind extends CallableKind> = Kind extends 'node' ? { readonly members?: never } : { readonly members: readonly ChildrenOf<Kind>[] };
export type { CallableContract, CallableInput, CallableOutput, CallableDelta, CallableShape } from './signature.js';

declare const childReferenceSignature: unique symbol;
/** Certified by this parent activity; the opaque identity does not grant action rights. */
export interface ChildReference<Definition = unknown> {
  readonly [childReferenceSignature]: Definition;
}

export interface ChildCall<Definition extends ChildContract> {
  readonly ref: ChildReference<Definition>;
  readonly key?: string;
  invoke(): Promise<CallableOutput<Definition>>;
  invoke<Value, const Options extends ChildInvocationReceptionOptions<Definition, NoInfer<Value>>>(options: Options & { readonly reception: ReceptionDefinition<Definition, Value> }): Promise<OperationResult<CallableOutput<Definition>, Options>>;
  invoke<const Options extends ChildInvocationOptions<Definition>>(options: Options & ChildInvocationOptions<Definition>): Promise<OperationResult<CallableOutput<Definition>, Options>>;
  run(): Promise<CallableOutput<Definition>>;
  accept(): Promise<CallableOutput<Definition>>;
  accept<Value>(receive: (output: CallableOutput<Definition>) => Value | Promise<Value>): Promise<Value>;
  accept<Value>(reception: ReceptionDefinition<Definition, Value>, receive: (output: CallableOutput<Definition>) => NoInfer<Value> | Promise<NoInfer<Value>>): Promise<Value>;
}

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

export interface ChildCalls<Allowed extends ChildContract = ChildContract> {
  invoke<Definition extends Allowed | CallableShape<Allowed>>(definition: Definition, input: NoInfer<CallableInput<Definition>>): Promise<CallableOutput<Definition>>;
  invoke<Definition extends Allowed | CallableShape<Allowed>, Value, const Options extends ChildReceptionOptions<NoInfer<Definition>, NoInfer<Value>>>(definition: Definition, input: NoInfer<CallableInput<Definition>>, options: Options & { readonly reception: ReceptionDefinition<NoInfer<Definition>, Value> }): Promise<OperationResult<CallableOutput<Definition>, Options>>;
  invoke<Definition extends Allowed | CallableShape<Allowed>, const Options extends ChildOperationOptions<NoInfer<Definition>>>(definition: Definition, input: NoInfer<CallableInput<Definition>>, options: Options & ChildOperationOptions<NoInfer<Definition>>): Promise<OperationResult<CallableOutput<Definition>, Options>>;
  create<Definition extends Allowed | CallableShape<Allowed>>(definition: Definition, input: NoInfer<CallableInput<Definition>>, options?: ChildOptions<Definition>): ChildCall<Definition>;
  entry<Definition extends Allowed | CallableShape<Allowed>, Input>(entry: ChildEntry<Definition, Input>, input: NoInfer<Input>, options?: ChildOptions<Definition>): ChildCall<Definition>;
  open<Definition extends ChildContract>(reference: ChildReference<Definition>): ChildCall<Definition>;
  readonly facts: ChildFacts;
}
export interface ResumeChildCalls<Allowed extends ChildContract = ChildContract> extends ChildCalls<Allowed> {
  resume<Definition extends Allowed | CallableShape<Allowed>>(reference: ChildReference<Definition>): ChildCall<Definition>;
}
