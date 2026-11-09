import { ProgressChannel, type ProgressReceiver } from '@weiliang0121/capix-changes';
import type { ConversationStage } from '@weiliang0121/capix-protocol';
import type { RunnerObservation, RunnerObservationEvent } from '@weiliang0121/capix-runtime';
import type { ToolLoop } from '../tools/loop.js';

export interface ToolStageEvent {
  readonly entryId: string;
  readonly stage: ConversationStage;
}

/** Current activity from exact ToolLoop members. No recorder, text, CP replay or execution authority. */
export class ToolStages {
  readonly #subscribers = new Set<ProgressChannel<ToolStageEvent>>();
  readonly #entries = new Map<string, { loops: Set<string>; started: Set<string> }>();
  readonly #targets: ReadonlyMap<string, Pick<ConversationStage, 'kind' | 'label'>>;
  readonly #unsubscribe: () => void;
  #closed = false;

  constructor(
    observation: RunnerObservation,
    private readonly loop: ToolLoop,
  ) {
    this.#targets = new Map<string, Pick<ConversationStage, 'kind' | 'label'>>([[loop.stages.model, { kind: 'model', label: '模型处理' }], ...loop.stages.tools.map((tool) => [tool.structureId, { kind: 'tool' as const, label: tool.name.slice(0, 120) }] as const)]);
    this.#unsubscribe = observation.subscribe({
      receive: (event) => this.receive(event),
      failed: () => {
        this.close();
        return undefined;
      },
    });
  }

  subscribe(receiver: ProgressReceiver<ToolStageEvent>): () => void {
    if (this.#closed) throw new Error('Tool stages are closed');
    const channel = new ProgressChannel(receiver);
    this.#subscribers.add(channel);
    return () => this.#subscribers.delete(channel);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    this.#entries.clear();
    this.#subscribers.clear();
  }

  private receive(event: RunnerObservationEvent): undefined {
    if (this.#closed) return undefined;
    if (event.source === 'entry') {
      if (event.fact.kind === 'acquired') this.#entries.set(event.entryId, { loops: new Set(), started: new Set() });
      if (event.fact.kind === 'released') this.#entries.delete(event.entryId);
      return undefined;
    }
    const entry = this.#entries.get(event.entryId);
    if (!entry) return undefined;
    // Restored baselines and reused deliveries are not new work. Only live activity
    // emitted during this entry is eligible, including genuinely resumed execution.
    const fact = event.source === 'invocation' ? event.fact : event.source === 'checkpoint' && event.fact.kind === 'activity' ? event.fact.fact : undefined;
    if (!fact) return undefined;
    const identity = fact.identity;
    if (fact.description?.id === this.loop.id) entry.loops.add(identity.contextId);
    if (!identity.parentContextId || !entry.loops.has(identity.parentContextId)) return undefined;
    const target = fact.description?.id ? this.#targets.get(fact.description.id) : undefined;
    if (!target) return undefined;
    let status: ConversationStage['status'];
    if (fact.kind === 'started' || (fact.kind === 'process' && fact.action === 'start')) {
      if (entry.started.has(identity.contextId)) return undefined;
      entry.started.add(identity.contextId);
      status = 'running';
    } else if (fact.kind === 'finished' && entry.started.has(identity.contextId)) {
      entry.started.delete(identity.contextId);
      status = fact.status;
    } else return undefined;
    const value = Object.freeze({ entryId: event.entryId, stage: Object.freeze({ contextId: identity.contextId, ...target, status }) });
    for (const channel of [...this.#subscribers]) {
      if (!this.#subscribers.has(channel)) continue;
      channel.publish(value);
      if (channel.failure) this.#subscribers.delete(channel);
    }
    return undefined;
  }
}
