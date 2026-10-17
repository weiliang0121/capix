import type { InvocationLevel } from '@capix/protocol';
import type { DeclaredException } from '../exception/contract.js';
import type { ChildCalls, ChildDefinition, ChildReference, ResumeChildCalls } from './children.js';
import type { AuthorCheckpointWriter } from './checkpoint.js';

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
}

type Children<Level extends InvocationLevel, Allowed extends ChildDefinition, Restoring extends boolean> = Level extends 'attempt' ? object : { readonly children: Restoring extends true ? ResumeChildCalls<Allowed> : ChildCalls<Allowed> };
type OutputPort<Delta> = [Delta] extends [never] ? object : { readonly output: { emit(delta: Delta): void } };

export type ExecuteWork<Level extends InvocationLevel, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildDefinition = ChildDefinition, Delta = never, Restoring extends boolean = false> = Work<Input, Resources> & Children<Level, Allowed, Restoring> & OutputPort<Delta> & { readonly checkpoint?: AuthorCheckpointWriter<Level, Input, Output, Delta> };
export type AcceptWork<Level extends InvocationLevel, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildDefinition = ChildDefinition> = Work<Input, Resources> & Children<Level, Allowed, false> & { readonly delivered: Output; continue(input: Input, reason: string): Continue<Input> };
export type HandleWork<Level extends InvocationLevel, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildDefinition = ChildDefinition> = Work<Input, Resources> & Children<Level, Allowed, false> & { readonly exception: DeclaredException; readonly origin: ExceptionOrigin; continue(input: Input, reason: string): Resolution<Input, Output>; return(output: Output): Resolution<Input, Output>; readonly unhandled: Resolution<Input, Output> };
export type ResumeWork<Level extends InvocationLevel, Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildDefinition = ChildDefinition, Delta = never> = ExecuteWork<Level, Input, Output, Resources, Allowed, Delta, true>;

export type RuntimeWork<Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildDefinition = ChildDefinition, Delta = never> = ExecuteWork<'runtime', Input, Output, Resources, Allowed, Delta>;
export type ExecutionWork<Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildDefinition = ChildDefinition, Delta = never> = ExecuteWork<'execution', Input, Output, Resources, Allowed, Delta>;
export type OperationWork<Input, Output, Resources extends object = Record<string, never>, Allowed extends ChildDefinition = ChildDefinition, Delta = never> = ExecuteWork<'operation', Input, Output, Resources, Allowed, Delta>;
export type AttemptWork<Input, Output, Resources extends object = Record<string, never>, Delta = never> = ExecuteWork<'attempt', Input, Output, Resources, never, Delta>;
