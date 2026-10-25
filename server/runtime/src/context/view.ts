import type { ContextState, InvocationContext } from './context.js';
import type { ResourceBindings } from '../resource/bindings.js';

/** Business sees the live call values, never lifecycle mutation or binding machinery. */
export interface InvocationContextView<Input = unknown, Output = unknown> {
  readonly id: string;
  readonly input: Input;
  readonly currentInput: Input;
  readonly progress: InvocationContext<Input, Output>['progress'];
  readonly state: ContextState<Output>;
  readonly status: ContextState<Output>['status'];
}

interface ResourceContextView<Input, Output, Resources extends object> extends InvocationContextView<Input, Output> {
  readonly signal: AbortSignal;
  readonly resources: { readonly values: Readonly<Resources> };
}
export interface CallableContextView<Input = unknown, Output = unknown, Resources extends object = object> extends ResourceContextView<Input, Output, Resources> {
  readonly kind: import('@capix/protocol').CallableKind;
}

export type ContextViewOf<Context extends InvocationContext<any, any>> = Context extends InvocationContext<infer Input, infer Output> & { readonly resources: ResourceBindings<infer Resources>; readonly signal: AbortSignal; readonly kind: import('@capix/protocol').CallableKind } ? CallableContextView<Input, Output, Resources> : Context extends InvocationContext<infer Input, infer Output> ? InvocationContextView<Input, Output> : never;

export type ContextViewResources<ContextView extends InvocationContextView<any, any>, Resources extends object> = Omit<ContextView, 'resources'> & { readonly resources: { readonly values: Readonly<Resources> } };

/** Relationship and child views expose call facts, never another declaration's capabilities. */
export type ContextFactsOf<Context extends InvocationContext<any, any>> = Omit<ContextViewOf<Context>, 'resources'>;

export function invocationContextView<Context extends InvocationContext<any, any>>(context: Context): ContextFactsOf<Context>;
export function invocationContextView<Context extends InvocationContext<any, any>>(context: Context, values: Readonly<object>): ContextViewOf<Context>;
export function invocationContextView<Context extends InvocationContext<any, any>>(context: Context, values?: Readonly<object>): ContextViewOf<Context> | ContextFactsOf<Context> {
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
  };
  if ('resources' in context && 'signal' in context) {
    Object.defineProperties(view, { kind: { enumerable: true, value: 'kind' in context ? context.kind : undefined }, signal: { enumerable: true, value: context.signal } });
    if (values) Object.defineProperty(view, 'resources', { enumerable: true, value: Object.freeze({ values }) });
  }
  return Object.freeze(view) as ContextViewOf<Context>;
}
