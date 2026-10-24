import type { CallableKind } from '@capix/protocol';
import type { DeclaredException } from '../exception/contract.js';
import type { ChildCalls, ChildContract, ChildContractsOf, ChildReference, ResumeChildCalls } from './children.js';
import type { AuthorCheckpointWriter } from './checkpoint.js';
import type { BusinessEvent } from '../observation/facts.js';

export type ExceptionOrigin = { readonly kind: 'self'; readonly phase: 'execute' | 'accept' } | { readonly kind: 'child-return' | 'child-reception'; readonly child: ChildReference };

export interface ContinuationFact {
  readonly fromRound: 1;
  readonly stage: 'accept' | 'handling';
  readonly reason: string;
  readonly origin?: ExceptionOrigin;
}

declare const continuationSignature: unique symbol;
export interface Continue<Input> {
  readonly [continuationSignature]: Input;
}

declare const resolutionSignature: unique symbol;
/** Issued by a current handling Work, not an ordinary tagged business value. */
export interface Resolution<Input, Output> {
  readonly [resolutionSignature]: { readonly input: Input; readonly output: Output };
}

export interface Work<Input, Resources extends object> {
  readonly input: Input;
  readonly initialInput: Input;
  readonly round: 1 | 2;
  readonly resources: Readonly<Resources>;
  readonly signal: AbortSignal;
  readonly continuation?: ContinuationFact;
  observation(event: BusinessEvent): void;
}

export interface CompositeWork<Allowed extends ChildContract = ChildContract, Restoring extends boolean = false> {
  readonly children: Restoring extends true ? ResumeChildCalls<Allowed> : ChildCalls<Allowed>;
}
type Children<Kind extends CallableKind, Allowed extends ChildContractsOf<Kind>, Restoring extends boolean> = Kind extends 'node' ? object : CompositeWork<Allowed, Restoring>;
type OutputPort<Delta> = [Delta] extends [never] ? object : { readonly output: { emit(delta: Delta): void } };

export type ExecuteWork<Kind extends CallableKind, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>, Delta = never, Restoring extends boolean = false> = Work<Input, Resources> & Children<Kind, Allowed, Restoring> & OutputPort<Delta> & { readonly checkpoint?: AuthorCheckpointWriter<Kind, Input, Output, Delta> };
export type AcceptWork<Kind extends CallableKind, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>> = Work<Input, Resources> & Children<Kind, Allowed, false> & { readonly delivered: Output; continue(input: Input, reason: string): Continue<Input> };
export type HandleWork<Kind extends CallableKind, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>> = Work<Input, Resources> & Children<Kind, Allowed, false> & { readonly exception: DeclaredException; readonly origin: ExceptionOrigin; continue(input: Input, reason: string): Resolution<Input, Output>; return(output: Output): Resolution<Input, Output>; readonly unhandled: Resolution<Input, Output> };
export type ResumeWork<Kind extends CallableKind, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContractsOf<Kind> = ChildContractsOf<Kind>, Delta = never> = ExecuteWork<Kind, Input, Output, Resources, Allowed, Delta, true>;

export type SceneWork<Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContract = ChildContract, Delta = never> = ExecuteWork<'scene', Input, Output, Resources, Allowed, Delta>;
export type GroupWork<Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildContract = ChildContract, Delta = never> = ExecuteWork<'group', Input, Output, Resources, Allowed, Delta>;
export type NodeWork<Input, Output, Resources extends object = Record<string, never>, Delta = never> = ExecuteWork<'node', Input, Output, Resources, never, Delta>;
