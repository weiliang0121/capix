import type { InvocationOutputReceiver } from '../output/contract.js';
import type { ResourceInstallation } from '../resource/installation.js';
import type { ResourceSupply } from '../resource/supply.js';
import type { ProgressReceiver } from '../progress.js';
import type { InvocationProgress } from '../invocation/progress.js';
import type { CallableInvocationStarted } from '../invocation/builders/callable.js';
import type { AnyCallable } from './declarations.js';
import type { CallableHooks, CallableHookBinding } from './hooks.js';

/** Inputs to one invocation construction; resource supply has no access window or call owner. */
export interface CallAccess {
  readonly supply?: ResourceSupply;
  readonly started?: CallableInvocationStarted<any, any, any>;
  readonly progress?: ProgressReceiver<InvocationProgress>;
  readonly output?: InvocationOutputReceiver<any, any>;
}

/** The construction seam shared by explicit resource assembly and the legacy source adapter. */
export interface CallInstallation<Options> {
  begin(options: Options): CallableCallBindings<Options>;
  require(value: object | undefined): CallableCallBindings<Options>;
  open(structure: AnyCallable, input: unknown, options: Options, restoring: boolean, inherited?: ResourceSupply): CallAccess;
}

export interface CallableCallsOptions<Options> {
  readonly hooks?: readonly CallableHookBinding<Options>[];
  readonly validate?: (options: Options) => undefined;
}

/** One run's host conditions and fixed installation identity, shared by its child constructions. */
export class CallableCallBindings<Options = unknown> {
  constructor(
    private readonly owner: CallInstallation<Options>,
    private readonly options: Options,
  ) {
    Object.freeze(this);
  }

  belongsTo(owner: CallInstallation<Options>): boolean {
    return this.owner === owner;
  }

  open(structure: AnyCallable, input: unknown, restoring: boolean, inherited?: ResourceSupply): CallAccess {
    return this.owner.open(structure, input, this.options, restoring, inherited);
  }
}

/** Compose host call hooks with resource supply; neither concern owns the other's lifecycle. */
export class CallableCalls<Options> implements CallInstallation<Options> {
  constructor(
    private readonly resources: ResourceInstallation<Options>,
    private readonly hooks: CallableHooks<Options>,
    private readonly validate?: (options: Options) => undefined,
  ) {}

  begin(options: Options): CallableCallBindings<Options> {
    const result: unknown = this.validate?.(options);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => undefined);
      throw new TypeError('Runner validation must return undefined synchronously');
    }
    return new CallableCallBindings(this, options);
  }

  require(value: object | undefined): CallableCallBindings<Options> {
    if (!(value instanceof CallableCallBindings) || !value.belongsTo(this)) throw new Error('Call construction belongs to another binding installation');
    return value;
  }

  open(structure: AnyCallable, input: unknown, options: Options, restoring: boolean, inherited?: ResourceSupply): CallAccess {
    this.hooks.validate(structure, input, options);
    const supply = this.resources.open(structure, input, options, inherited);
    return { supply, ...this.hooks.open(structure, input, options, restoring) };
  }
}
