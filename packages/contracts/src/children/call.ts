import type { Stable } from '../value.js';
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
  invoke(): Promise<Stable<CallableOutput<Definition>>>;
  invoke<Value, const Options extends NoInfer<ChildInvocationReceptionOptions<Definition, Value>>>(options: Options & { readonly reception: ReceptionDefinition<Definition, Value> }): Promise<Stable<OperationResult<Stable<CallableOutput<Definition>>, Options>>>;
  invoke<const Options extends ChildInvocationOptions<Definition>>(options: Options & ChildInvocationOptions<Definition>): Promise<Stable<OperationResult<Stable<CallableOutput<Definition>>, Options>>>;
  run(): Promise<Stable<CallableOutput<Definition>>>;
  accept(): Promise<Stable<CallableOutput<Definition>>>;
  accept<Value>(receive: (output: Stable<CallableOutput<Definition>>) => Value | Stable<Value> | Promise<Value | Stable<Value>>): Promise<Stable<Value>>;
  accept<Value>(reception: ReceptionDefinition<Definition, Value>, receive: (output: Stable<CallableOutput<Definition>>) => NoInfer<Value> | NoInfer<Stable<Value>> | Promise<NoInfer<Value> | NoInfer<Stable<Value>>>): Promise<Stable<Value>>;
}

export interface ChildCalls<Allowed extends ChildContract = ChildContract> {
  invoke<Definition extends Allowed | CallableShape<Allowed>>(definition: Definition, input: NoInfer<CallableInput<Definition> | Stable<CallableInput<Definition>>>): Promise<Stable<CallableOutput<Definition>>>;
  invoke<Definition extends Allowed | CallableShape<Allowed>, Value, const Options extends NoInfer<ChildReceptionOptions<Definition, Value>>>(definition: Definition, input: NoInfer<CallableInput<Definition> | Stable<CallableInput<Definition>>>, options: Options & { readonly reception: ReceptionDefinition<NoInfer<Definition>, Value> }): Promise<Stable<OperationResult<Stable<CallableOutput<Definition>>, Options>>>;
  invoke<Definition extends Allowed | CallableShape<Allowed>, const Options extends ChildOperationOptions<NoInfer<Definition>>>(definition: Definition, input: NoInfer<CallableInput<Definition> | Stable<CallableInput<Definition>>>, options: Options & ChildOperationOptions<NoInfer<Definition>>): Promise<Stable<OperationResult<Stable<CallableOutput<Definition>>, Options>>>;
  create<Definition extends Allowed | CallableShape<Allowed>>(definition: Definition, input: NoInfer<CallableInput<Definition> | Stable<CallableInput<Definition>>>, options?: ChildOptions<Definition>): ChildCall<Definition>;
  open<Definition extends ChildContract>(reference: ChildReference<Definition>): ChildCall<Definition>;
  readonly facts: ChildFacts;
}
export interface ResumeChildCalls<Allowed extends ChildContract = ChildContract> extends ChildCalls<Allowed> {
  resume<Definition extends Allowed | CallableShape<Allowed>>(reference: ChildReference<Definition>): ChildCall<Definition>;
}
