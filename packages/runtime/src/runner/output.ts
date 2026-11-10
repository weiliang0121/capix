import { ProgressChannel } from '@weiliang0121/capix-changes';
import type { InvocationOutputEvent, InvocationOutputReceiver, ProgressReceiver } from '@weiliang0121/capix-contracts';

/** Entry identity separates new runs and restoration activities without changing call identity. */
export type RunnerOutputEvent<Result, Delta = never> = InvocationOutputEvent<Result, Delta> & Readonly<{ entryId: string }>;

/** Live Scene output across this Runner's calls. Subscription never starts or cancels execution. */
export interface RunnerOutput<Result, Delta = never> {
  subscribe(receiver: ProgressReceiver<RunnerOutputEvent<Result, Delta>>): () => void;
}

/** Private publication side; the public port only permits consumption. No history is retained. */
export class RunnerOutputSubscriptions<Result, Delta> {
  readonly #subscribers = new Set<ProgressChannel<RunnerOutputEvent<Result, Delta>>>();
  readonly port: RunnerOutput<Result, Delta> = Object.freeze({ subscribe: (receiver: ProgressReceiver<RunnerOutputEvent<Result, Delta>>) => this.subscribe(receiver) });

  forEntry(entryId: string): InvocationOutputReceiver<Result, Delta> {
    return Object.freeze({ receive: (event: InvocationOutputEvent<Result, Delta>) => this.publish(event, entryId) });
  }

  private subscribe(receiver: ProgressReceiver<RunnerOutputEvent<Result, Delta>>): () => void {
    if (!receiver || typeof receiver.receive !== 'function' || (receiver.failed !== undefined && typeof receiver.failed !== 'function')) throw new TypeError('Output subscription requires a synchronous receiver');
    const channel = new ProgressChannel<InvocationOutputEvent<Result, Delta>>({ receive: receiver.receive.bind(receiver), failed: receiver.failed?.bind(receiver) });
    this.#subscribers.add(channel);
    return () => {
      this.#subscribers.delete(channel);
    };
  }

  private publish(event: InvocationOutputEvent<Result, Delta>, entryId: string): undefined {
    if (!this.#subscribers.size) return;
    const output = Object.freeze({ ...event, entryId });
    for (const channel of [...this.#subscribers]) {
      if (!this.#subscribers.has(channel)) continue;
      channel.publish(output);
      if (channel.failure) this.#subscribers.delete(channel);
    }
  }
}
