import { requireNotCancelled } from './cancellation.js';

/** Local activity window. Semantic progress stays in Context; owned activities stay in Children. */
export class InvocationControl {
  #started = false;
  #closing = false;

  constructor(readonly signal: AbortSignal) {}

  start(): void {
    if (this.#started) throw new Error('Invocation has already started');
    this.#started = true;
  }

  requireActive(): void {
    if (this.#closing) throw new Error('Invocation activity window is closed');
    requireNotCancelled(this.signal);
  }

  /** Stop admitting work before joining owned activities, without cancelling external interactions. */
  close(): void {
    this.#closing = true;
  }
}
