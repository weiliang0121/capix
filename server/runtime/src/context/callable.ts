import { InvocationResources } from '../invocation/resource-access.js';
import type { CallableKind } from '@capix/contracts';
import { InvocationContext, type InvocationControls } from './context.js';
import { type ResourceRequirements } from '@capix/resources';
import { requireNotCancelled } from '../invocation/cancellation.js';

/** One callable's state and local resource access; no ancestor or source resolver is retained. */
export class CallableContext<Input = unknown, Output = unknown, Resources extends object = object> extends InvocationContext<Input, Output> {
  readonly signal: AbortSignal;
  readonly #owner?: object;

  constructor(
    input: Input,
    readonly kind: CallableKind,
    controls: InvocationControls = {},
    readonly resources: InvocationResources<Resources> = new InvocationResources({} as ResourceRequirements<Resources>),
    owner?: object,
  ) {
    super(input);
    this.signal = controls.signal ?? new AbortController().signal;
    this.#owner = owner;
    Object.freeze(this);
  }

  belongsTo(owner: object): boolean {
    return this.#owner === undefined || this.#owner === owner;
  }

  requireActive(): void {
    this.requireRunning();
    requireNotCancelled(this.signal);
  }
}
