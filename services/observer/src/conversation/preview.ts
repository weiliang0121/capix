import type { AnswerPreviewChange, AnswerPreviewSnapshot } from '@weiliang0121/capix-protocol';
import type { AnswerProgress, AnswerSource } from './group/answer/stream.js';

/** Submission-local public interpretation of explicitly selected answer outputs. */
export class ConversationPreviewProjection {
  private state?: AnswerPreviewSnapshot;
  private source?: AnswerSource;
  private sequence = 0;

  constructor(private readonly changed: (change: AnswerPreviewChange) => void) {}

  get snapshot(): AnswerPreviewSnapshot | undefined {
    return this.state;
  }

  receive(fact: AnswerProgress): undefined {
    if (fact.kind === 'committed') {
      if (!this.matches(fact.source) || !this.state || this.state.state === 'discarded') return;
      if (this.state.state !== 'received') throw new Error('Only a completed candidate can be committed');
      const consistency = fact.content === this.state.text ? 'complete' : fact.content.startsWith(this.state.text) ? 'prefix' : 'mismatch';
      this.install({ kind: 'committed', generation: this.state.generation, revision: this.state.revision + 1, message: Object.freeze({ ...fact.message }), consistency });
      return;
    }
    const event = fact.event;
    if (event.kind === 'started') {
      if (this.state && this.state.state !== 'discarded') throw new Error('Cannot replace an active or committed candidate');
      this.source = { contextId: event.contextId, round: event.round };
      this.sequence = event.sequence;
      this.install({ kind: 'started', generation: (this.state?.generation ?? 0) + 1, revision: 1 });
      return;
    }
    if (!this.matches(event) || !this.state || event.sequence !== this.sequence + 1) throw new Error('Answer output source or sequence mismatch');
    this.sequence = event.sequence;
    if (event.kind === 'delta') {
      if (this.state.state !== 'streaming') throw new Error('Candidate no longer accepts text');
      if (this.state.text.length + event.delta.text.length > 2_000_000) throw new Error('Answer preview exceeds delivery capacity');
      this.install({ kind: 'appended', generation: this.state.generation, revision: this.state.revision + 1, offset: this.state.text.length, text: event.delta.text });
    } else if (event.kind === 'completed' && !event.discarded) {
      this.install({ kind: 'received', generation: this.state.generation, revision: this.state.revision + 1 });
    } else if (event.kind === 'discarded' && event.reason !== 'failed') this.finish('rejected');
  }

  finish(reason: 'rejected' | 'failed' | 'cancelled'): void {
    if (!this.state || this.state.state === 'committed' || this.state.state === 'discarded') return;
    this.install({ kind: 'discarded', generation: this.state.generation, revision: this.state.revision + 1, reason });
  }

  private matches(source: AnswerSource): boolean {
    return this.source?.contextId === source.contextId && this.source.round === source.round;
  }

  private install(change: AnswerPreviewChange): void {
    if (change.kind === 'started') this.state = Object.freeze({ generation: change.generation, revision: change.revision, state: 'streaming', text: '' });
    else {
      const previous = this.state!;
      this.state = Object.freeze({ ...previous, revision: change.revision, ...(change.kind === 'appended' ? { text: previous.text + change.text } : {}), ...(change.kind === 'received' ? { state: 'received' as const } : {}), ...(change.kind === 'committed' ? { state: 'committed' as const, message: change.message, consistency: change.consistency } : {}), ...(change.kind === 'discarded' ? { state: 'discarded' as const, reason: change.reason } : {}) });
    }
    this.changed(Object.freeze(change));
  }
}
