import type { AnyCallable } from '../binding/declarations.js';
import type { CallableBinding } from '../binding/contract.js';
import type { CallInstallation } from '../binding/calls.js';
import type { CallableInvocationBuilder } from '../construction/invocation.js';

declare const builtOptions: unique symbol;

/** A type refinement of the original structure, never another structural object. */
export type BuiltCallable<Structure extends AnyCallable, Options = unknown> = Structure & { readonly [builtOptions]: (options: Options) => Options };
export type AnyBuiltCallable = AnyCallable & { readonly [builtOptions]: (options: never) => unknown };
export type BuiltOptions<Structure> = Structure extends { readonly [builtOptions]: (options: infer Options) => unknown } ? Options : never;

/** Fixed construction data owned by the original callable; no current invocation is retained. */
export interface CallableConstruction {
  readonly binding: CallableBinding<any, any, object>;
  readonly calls: CallInstallation<any>;
  readonly invocations: CallableInvocationBuilder;
}

const construction = Symbol('callable-construction');
type Constructed = AnyCallable & { readonly [construction]: CallableConstruction };

export function callableConstruction(structure: AnyCallable): CallableConstruction {
  if (!Object.hasOwn(structure, construction)) throw new Error('Callable structure has not been built');
  return (structure as Constructed)[construction];
}

export function installCallableConstruction(structure: AnyCallable, value: CallableConstruction): void {
  Object.defineProperty(structure, construction, { value: Object.freeze(value) });
}
