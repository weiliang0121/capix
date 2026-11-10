import type { InvocationOutputReceiver } from '@weiliang0121/capix-contracts';
import type { ResourceInstallation } from '../resource/installation.js';
import type { ResourceSupply } from '@weiliang0121/capix-resources';
import type { ProgressReceiver } from '@weiliang0121/capix-changes';
import { requireNotCancelled, type InvocationProgress } from '@weiliang0121/capix-invocation';
import type { CallableInvocationStarted } from '../construction/invocation.js';
import type { AnyCallable } from './declarations.js';
import type { CallableHooks, CallableHookBinding } from './hooks.js';
import { bindCallableFeedback, type CallableFeedback, type CallableFeedbackBinding } from '../construction/feedback.js';

/** Inputs to one invocation construction; resource supply has no access window or call owner. */
export interface PreparedCall {
  readonly supply?: ResourceSupply;
  readonly started?: CallableInvocationStarted<any, any, any>;
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly output?: InvocationOutputReceiver<any, any>;
}

/** The construction seam shared by explicit resource assembly and the legacy source adapter. */
export interface CallInstallation<Options> {
  begin(options: Options, feedback?: CallableFeedback): CallableCallScope<Options>;
  require(value: object | undefined): CallableCallScope<Options>;
  prepare(structure: AnyCallable, input: unknown, options: Options, restoring: boolean, inherited?: ResourceSupply, signal?: AbortSignal): PreparedCall;
}

export interface CallableCallsOptions<Options> {
  readonly hooks?: readonly CallableHookBinding<Options>[];
  readonly validate?: (options: Options) => undefined;
}

/** One run's host conditions and fixed installation identity, shared by its child constructions. */
export class CallableCallScope<Options = unknown> {
  readonly feedback?: CallableFeedbackBinding;
  constructor(
    private readonly owner: CallInstallation<Options>,
    private readonly options: Options,
    feedback?: CallableFeedback,
  ) {
    this.feedback = feedback ? bindCallableFeedback(feedback) : undefined;
    Object.freeze(this);
  }

  belongsTo(owner: CallInstallation<Options>): boolean {
    return this.owner === owner;
  }

  prepare(structure: AnyCallable, input: unknown, restoring: boolean, inherited?: ResourceSupply, signal?: AbortSignal): PreparedCall {
    return this.owner.prepare(structure, input, this.options, restoring, inherited, signal);
  }
}

/** Compose host call hooks with resource supply; neither concern owns the other's lifecycle. */
export class CallableCalls<Options> implements CallInstallation<Options> {
  constructor(
    private readonly resources: ResourceInstallation<Options>,
    private readonly hooks: CallableHooks<Options>,
    private readonly validate?: (options: Options) => undefined,
  ) {}

  begin(options: Options, feedback?: CallableFeedback): CallableCallScope<Options> {
    const result: unknown = this.validate?.(options);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('Runner validation must return undefined synchronously');
    }
    return new CallableCallScope(this, options, feedback);
  }

  require(value: object | undefined): CallableCallScope<Options> {
    if (!(value instanceof CallableCallScope) || !value.belongsTo(this)) throw new Error('Call construction belongs to another binding installation');
    return value;
  }

  prepare(structure: AnyCallable, input: unknown, options: Options, restoring: boolean, inherited?: ResourceSupply, signal?: AbortSignal): PreparedCall {
    if (signal) requireNotCancelled(signal);
    this.hooks.validate(structure, input, options);
    if (signal) requireNotCancelled(signal);
    const supply = this.resources.open(structure, input, options, inherited);
    if (signal) requireNotCancelled(signal);
    return { supply, ...this.hooks.open(structure, input, options, restoring, signal) };
  }
}
