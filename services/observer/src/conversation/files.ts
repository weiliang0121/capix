import type { FileOutput } from '@weiliang0121/capix-protocol';
import type { FileProgress } from '../files/index.js';

/** Interprets one requested output independently of the enclosing call and its answer. */
export class ConversationFileProjection {
  private state: FileOutput | undefined;
  private started = false;
  private incomplete = false;

  constructor(private readonly changed: (output: FileOutput) => void) {}

  receive(fact: FileProgress): undefined {
    if (this.incomplete) return;
    if (fact.kind === 'requested') {
      if (this.state) throw new Error('File output was requested more than once');
      this.publish({ status: 'pending', path: fact.path });
      return;
    }
    const path = fact.kind === 'created' ? fact.receipt.path : fact.path;
    if (!this.state || this.state.status !== 'pending' || this.state.path !== path) throw new Error('File progress does not match the pending output');
    if (fact.kind === 'started') {
      if (this.started) throw new Error('File output was started more than once');
      this.started = true;
      return;
    }
    if (!this.started) throw new Error('File output has not started');
    if (fact.kind === 'created') this.publish({ status: 'created', receipt: Object.freeze({ ...fact.receipt }) });
    else if (fact.kind === 'not-created') this.publish({ status: 'not-created', path, reason: fact.reason });
    else this.publish({ status: 'unconfirmed', path });
  }

  invalidate(): undefined {
    this.incomplete = true;
    // A confirmed publication is immutable, even if a later observer is defective.
    if (this.state?.status === 'pending') this.publish({ status: 'unconfirmed', path: this.state.path });
  }

  finish(): void {
    if (this.state?.status !== 'pending') return;
    if (this.incomplete || this.started) this.publish({ status: 'unconfirmed', path: this.state.path });
    else this.publish({ status: 'not-created', path: this.state.path, reason: 'not-started' });
  }

  private publish(output: FileOutput): void {
    this.state = Object.freeze(output);
    this.changed(this.state);
  }
}
