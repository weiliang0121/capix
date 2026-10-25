import type { CallableInput, CallableOutput, CallableShape } from '../callable/signature.js';
import type { OperationResult } from '../operation.js';
import type { ReceptionDefinition } from '../checkpoint/reception.js';
import type { ChildReference } from './reference.js';
import type { ChildContract } from './contract.js';
import type { ChildFacts } from './facts.js';
import type { ChildOptions, ChildOperationOptions, ChildReceptionOptions, ChildInvocationOptions, ChildInvocationReceptionOptions } from './options.js';

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

export interface ChildCalls<Allowed extends ChildContract = ChildContract> {
  invoke<Definition extends Allowed | CallableShape<Allowed>>(definition: Definition, input: NoInfer<CallableInput<Definition>>): Promise<CallableOutput<Definition>>;
  invoke<Definition extends Allowed | CallableShape<Allowed>, Value, const Options extends ChildReceptionOptions<NoInfer<Definition>, NoInfer<Value>>>(definition: Definition, input: NoInfer<CallableInput<Definition>>, options: Options & { readonly reception: ReceptionDefinition<NoInfer<Definition>, Value> }): Promise<OperationResult<CallableOutput<Definition>, Options>>;
  invoke<Definition extends Allowed | CallableShape<Allowed>, const Options extends ChildOperationOptions<NoInfer<Definition>>>(definition: Definition, input: NoInfer<CallableInput<Definition>>, options: Options & ChildOperationOptions<NoInfer<Definition>>): Promise<OperationResult<CallableOutput<Definition>, Options>>;
  create<Definition extends Allowed | CallableShape<Allowed>>(definition: Definition, input: NoInfer<CallableInput<Definition>>, options?: ChildOptions<Definition>): ChildCall<Definition>;
  open<Definition extends ChildContract>(reference: ChildReference<Definition>): ChildCall<Definition>;
  readonly facts: ChildFacts;
}
export interface ResumeChildCalls<Allowed extends ChildContract = ChildContract> extends ChildCalls<Allowed> {
  resume<Definition extends Allowed | CallableShape<Allowed>>(reference: ChildReference<Definition>): ChildCall<Definition>;
}
