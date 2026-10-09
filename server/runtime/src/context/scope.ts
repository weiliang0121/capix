import type { ContextState, InvocationContext } from './context.js';
import type { Continuation } from '../invocation/result.js';
import type { ResourceBindings } from '../resource/bindings.js';

/** Business sees the live call values, never lifecycle mutation or binding machinery. */
export interface InvocationScope<I = unknown, O = unknown> {
  readonly id: string;
  readonly input: I;
  readonly currentInput: I;
  readonly progress: InvocationContext<I, O>['progress'];
  readonly state: ContextState<O>;
  readonly status: ContextState<O>['status'];
  continueWith(input: I, reason: string): Continuation<I>;
}

interface ResourceScope<I, O, R extends object> extends InvocationScope<I, O> {
  readonly signal: AbortSignal;
  readonly resources: { readonly values: Readonly<R> };
}
export interface ExecutionScope<I = unknown, O = unknown, R extends object = object> extends ResourceScope<I, O, R> {
  readonly level: 'execution';
}
export interface OperationScope<I = unknown, O = unknown, R extends object = object> extends ResourceScope<I, O, R> {
  readonly level: 'operation';
}
export interface AttemptScope<I = unknown, O = unknown, R extends object = object> extends ResourceScope<I, O, R> {
  readonly level: 'attempt';
}

export type ScopeOf<C extends InvocationContext<any, any>> = C extends InvocationContext<infer I, infer O> & { readonly resources: ResourceBindings<infer R>; readonly signal: AbortSignal; readonly level: infer L } ? (L extends 'execution' ? ExecutionScope<I, O, R> : L extends 'operation' ? OperationScope<I, O, R> : AttemptScope<I, O, R>) : C extends InvocationContext<infer I, infer O> ? InvocationScope<I, O> : never;

export type ScopeResources<C extends InvocationScope<any, any>, R extends object> = Omit<C, 'resources'> & { readonly resources: { readonly values: Readonly<R> } };

/** Relationship and child views expose call facts, never another declaration's capabilities. */
export type InvocationFactsOf<C extends InvocationContext<any, any>> = Omit<ScopeOf<C>, 'resources'>;

export function invocationScope<C extends InvocationContext<any, any>>(context: C): InvocationFactsOf<C>;
export function invocationScope<C extends InvocationContext<any, any>>(context: C, values: Readonly<object>): ScopeOf<C>;
export function invocationScope<C extends InvocationContext<any, any>>(context: C, values?: Readonly<object>): ScopeOf<C> | InvocationFactsOf<C> {
  const view = {
    get id() {
      return context.id;
    },
    get input() {
      return context.input;
    },
    get currentInput() {
      return context.currentInput;
    },
    get progress() {
      return context.progress;
    },
    get state() {
      return context.state;
    },
    get status() {
      return context.status;
    },
    continueWith: (input: unknown, reason: string) => context.continueWith(input, reason),
  };
  if ('resources' in context && 'signal' in context) {
    Object.defineProperties(view, { level: { enumerable: true, value: 'level' in context ? context.level : undefined }, signal: { enumerable: true, value: context.signal } });
    if (values) Object.defineProperty(view, 'resources', { enumerable: true, value: Object.freeze({ values }) });
  }
  return Object.freeze(view) as ScopeOf<C>;
}
