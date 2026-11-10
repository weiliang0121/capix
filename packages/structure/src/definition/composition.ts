import type { ChildCallable } from './children.js';
import type { Stable, ChildContract, ChildOperationOptions, ChildReceptionOptions, CallableInput, CallableOutput, ReceptionDefinition, OperationResult } from '@weiliang0121/capix-contracts';

export type NamedMembers = Readonly<Record<string, ChildCallable>>;
type ReservedMemberName = '' | 'invoke' | 'create' | 'open' | 'facts' | 'resume' | '__proto__' | 'prototype' | 'constructor' | 'toString' | 'toLocaleString' | 'valueOf' | 'hasOwnProperty' | 'isPrototypeOf' | 'propertyIsEnumerable' | '__defineGetter__' | '__defineSetter__' | '__lookupGetter__' | '__lookupSetter__';
export type MemberRegistration<Names extends NamedMembers> = Names & { readonly [Name in keyof Names]: Name extends string ? (Name extends ReservedMemberName ? never : Names[Name]) : never };

declare const memberNames: unique symbol;
/** Type witness for names installed on the same structural object by add(). */
export interface NamedMemberRegistration<Names extends NamedMembers> {
  readonly [memberNames]: Names;
}
type MemberNamesOf<Owner> = Owner extends NamedMemberRegistration<infer Names> ? Names : {};

interface NamedChildOperation<Definition extends ChildContract> {
  invoke(input: CallableInput<Definition> | Stable<CallableInput<Definition>>): Promise<Stable<CallableOutput<Definition>>>;
  invoke<Value, const Options extends NoInfer<ChildReceptionOptions<Definition, Value>>>(input: CallableInput<Definition> | Stable<CallableInput<Definition>>, options: Options & { readonly reception: ReceptionDefinition<Definition, Value> }): Promise<Stable<OperationResult<Stable<CallableOutput<Definition>>, Options>>>;
  invoke<const Options extends ChildOperationOptions<Definition>>(input: CallableInput<Definition> | Stable<CallableInput<Definition>>, options: Options & ChildOperationOptions<Definition>): Promise<Stable<OperationResult<Stable<CallableOutput<Definition>>, Options>>>;
}
type NamedChildOperations<Owner, Allowed extends ChildContract> = { readonly [Name in keyof MemberNamesOf<Owner> as MemberNamesOf<Owner>[Name] extends Allowed ? Name : never]: MemberNamesOf<Owner>[Name] extends ChildContract ? NamedChildOperation<MemberNamesOf<Owner>[Name]> : never };
export type NamedWork<Work, Owner, Allowed extends ChildContract> = keyof NamedChildOperations<Owner, Allowed> extends never ? Work : Work & { readonly children: NamedChildOperations<Owner, Allowed> };

/** Membership is structural; named ports refer to these same members. */
export interface Composite<Members extends readonly ChildCallable[] = readonly ChildCallable[]> {
  readonly members: Members;
  readonly names?: NamedMembers;
}
