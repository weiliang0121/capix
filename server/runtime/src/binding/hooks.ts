import type { CallableInput, CallableOutput, CallableDelta, InvocationOutputReceiver } from '@capix/contracts';
import type { ProgressReceiver } from '../progress.js';
import type { InvocationProgress } from '../invocation/progress.js';
import type { CallableInvocationStarted } from '../invocation/builders/callable.js';
import type { AnyCallable, ResolvedCallable } from './declarations.js';
import type { CallAccess } from './calls.js';

/** Host call registration is independent of resource supply and never captures resources. */
export interface CallableHookDeclaration<Structure extends AnyCallable, Options> {
  readonly validate?: (input: CallableInput<Structure>, options: Options) => undefined;
  readonly started?: (input: CallableInput<Structure>, options: Options) => CallableInvocationStarted<CallableInput<Structure>, CallableOutput<Structure>> | undefined;
  readonly progress?: (input: CallableInput<Structure>, options: Options) => ProgressReceiver<InvocationProgress> | undefined;
  readonly output?: (input: CallableInput<Structure>, options: Options) => InvocationOutputReceiver<CallableOutput<Structure>, CallableDelta<Structure>> | undefined;
}

export interface CallableHookBinding<Options = {}, Structure extends AnyCallable = AnyCallable> {
  readonly structure: Structure;
  readonly hooks: CallableHookDeclaration<Structure, Options>;
}

/** Preserve the declaration's receiver; its methods are fixed when the Runner builds. */
export function callableHooks<Structure extends AnyCallable, Options = {}>(structure: Structure, hooks: CallableHookDeclaration<NoInfer<Structure>, Options>): CallableHookBinding<Options, Structure> {
  return Object.freeze({ structure, hooks });
}

type HookAccess = Omit<CallAccess, 'supply'>;

interface FixedHooks<Options> {
  readonly validate?: (input: unknown, options: Options) => undefined;
  readonly started?: (input: unknown, options: Options) => CallableInvocationStarted<any, any> | undefined;
  readonly progress?: (input: unknown, options: Options) => ProgressReceiver<InvocationProgress> | undefined;
  readonly output?: (input: unknown, options: Options) => InvocationOutputReceiver<any, any> | undefined;
}

/** Fixed callbacks by actual structure identity; no current call or endpoint is retained. */
export class CallableHooks<Options> {
  constructor(private readonly registrations: ReadonlyMap<AnyCallable, FixedHooks<Options>>) {}

  validate(structure: AnyCallable, input: unknown, options: Options): void {
    const hooks = this.registrations.get(structure);
    const validated: unknown = hooks?.validate?.(input, options);
    if (validated !== undefined) {
      void Promise.resolve(validated).catch(() => undefined);
      throw new TypeError('Callable validation must return undefined synchronously');
    }
  }

  open(structure: AnyCallable, input: unknown, options: Options, restoring: boolean): HookAccess {
    const hooks = this.registrations.get(structure);
    if (!hooks) return {};
    const started = restoring ? undefined : synchronous(hooks.started?.(input, options), 'started');
    if (started !== undefined && typeof started !== 'function') throw new TypeError('Callable started factory must return a callback or undefined');
    return {
      // Recovery preserves the old identity; it must not repeat necessary establishment work.
      started,
      progress: synchronous(hooks.progress?.(input, options), 'progress'),
      output: synchronous(hooks.output?.(input, options), 'output'),
    };
  }
}

export function bindCallableHooks<Options>(root: ResolvedCallable, registrations: readonly CallableHookBinding<Options>[]): CallableHooks<Options> {
  const members = new Set<AnyCallable>();
  const visit = (current: ResolvedCallable): void => {
    members.add(current.definition);
    for (const child of current.members) visit(child);
  };
  visit(root);
  const fixed = new Map<AnyCallable, FixedHooks<Options>>();
  for (const registration of registrations) {
    if (!members.has(registration.structure)) throw new Error('Call hooks require a structure in this scene');
    if (fixed.has(registration.structure)) throw new Error('Duplicate callable hooks registration');
    const hooks = registration.hooks;
    fixed.set(
      registration.structure,
      Object.freeze({
        validate: hooks.validate?.bind(hooks),
        started: hooks.started?.bind(hooks),
        progress: hooks.progress?.bind(hooks),
        output: hooks.output?.bind(hooks),
      }),
    );
  }
  return new CallableHooks(fixed);
}

function synchronous<Value>(value: Value, hook: string): Value {
  if (value !== null && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function') {
    void Promise.resolve(value).catch(() => undefined);
    throw new TypeError(`Callable ${hook} factory must be synchronous`);
  }
  return value;
}
