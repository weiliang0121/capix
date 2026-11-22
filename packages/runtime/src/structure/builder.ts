import { CallableBinder } from '../binding/callable.js';
import type { Resources } from '../resource/resources.js';
import type { CallableCallsOptions } from '../binding/calls.js';
import type { AnyCallable } from '../binding/declarations.js';
import { checkBuildArguments, snapshotInvocationCapabilities, type InvocationCapabilities } from '../construction/capabilities.js';
import type { BuiltCallable } from './construction.js';
import { installCallable } from './install.js';

/** Build fixed resource and mechanism wiring on the original callable tree. */
export class CallableBuilder {
  private readonly binder: CallableBinder;
  private readonly capabilities: InvocationCapabilities;

  constructor(capabilities: InvocationCapabilities = {}) {
    this.capabilities = snapshotInvocationCapabilities(capabilities);
    this.binder = new CallableBinder(this.capabilities);
  }

  build<Structure extends AnyCallable, Options extends object>(structure: Structure, resources: Resources<Options>, options: CallableCallsOptions<Options> = {}): BuiltCallable<Structure, Options> {
    checkBuildArguments(arguments, 'CallableBuilder.build(structure, resources, options?)');
    return installCallable(structure, this.capabilities, () => this.binder.bind(structure, resources, options));
  }
}
