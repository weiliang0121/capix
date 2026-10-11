import { InvocationStopped } from './stop.js';

/** A delivered cooperative stop belonging to one invocation control signal. */
export class InvocationCancelled extends InvocationStopped {
  readonly #signal: AbortSignal;

  constructor(signal: AbortSignal, options?: ErrorOptions) {
    if (!signal.aborted) throw new TypeError('Invocation cancellation requires an aborted signal');
    super('INVOCATION_CANCELLED', '调用已取消，不再推进后续工作。', undefined, options ?? { cause: signal.reason });
    this.#signal = signal;
  }

  belongsTo(signal: AbortSignal): boolean {
    return this.#signal === signal;
  }
}

/** A coincident abort or a composite failure is not proof of cancellation delivery. */
export function isInvocationCancelled(error: unknown, signal: AbortSignal): error is InvocationCancelled {
  return error instanceof InvocationCancelled && error.belongsTo(signal);
}

export function requireNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new InvocationCancelled(signal);
}
