import { RuntimeError } from '@capix/contracts';
import { RuntimeErrorHelper, type CheckpointInstallation, type CheckpointFact, type InvocationIdentity } from '@capix/server-runtime';
import { type CheckpointChild, type InvocationCheckpointFrame } from '@capix/checkpoint';
import type { ConversationCheckpointRuns } from '../conversation/checkpoints.js';

/** Install the service projection and an optional additional synchronous consumer. */
export function bindCheckpointObservation(observation: CheckpointObservation, additional?: CheckpointInstallation['observation']): NonNullable<CheckpointInstallation['observation']> {
  let active = additional;
  return {
    failure: additional?.failure ?? 'isolate',
    observe(fact) {
      observation.observe(fact);
      const consumer = active;
      if (!consumer) return;
      try {
        const returned: unknown = consumer.observe(fact);
        if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
          void Promise.resolve(returned).catch(() => undefined);
          throw new TypeError('Checkpoint observation must be synchronous');
        }
      } catch (error) {
        active = undefined;
        if (consumer.failure === 'propagate') throw error;
      }
    },
  };
}

/** Host observation metadata; this is deliberately not a public C/S protocol or a saved checkpoint. */
export interface CheckpointChildSummary {
  readonly owner: InvocationIdentity;
  readonly round: number;
  readonly order: number;
  readonly key?: string;
  readonly state: CheckpointChild['state']['kind'];
  readonly reception?: 'pending' | 'receiving' | 'accepted' | 'handled' | 'failed';
}
export interface CheckpointInstalledSummary {
  readonly round: number;
  readonly nextChildOrder: number;
  readonly childCount: number;
  readonly truncated: boolean;
  readonly children: readonly CheckpointChildSummary[];
}
export type CheckpointObservationEvent = Readonly<Pick<CheckpointFact, 'kind' | 'activityId' | 'contextId' | 'owner' | 'recovering' | 'sequence' | 'occurredAt'> & { readonly revision: number; readonly rootContextId?: string; readonly detail: ReturnType<typeof project> }>;
export interface CheckpointActivitySummary {
  readonly activityId: string;
  readonly contextId: string;
  readonly owner: InvocationIdentity;
  readonly rootContextId?: string;
  readonly recovering: boolean;
  readonly sequence: number;
  readonly revision: number;
  readonly last: CheckpointFact['kind'];
  readonly installed?: CheckpointInstalledSummary;
  readonly point?: string;
  readonly delivery?: 'succeeded' | 'failed' | 'cancelled';
}
export interface CheckpointObservationSnapshot {
  readonly conversationId: string;
  readonly rootContextId: string;
  readonly revision: number;
  readonly retainedFrom: number;
  readonly truncated: boolean;
  readonly activities: readonly CheckpointActivitySummary[];
  readonly events: readonly CheckpointObservationEvent[];
}
export type CheckpointObservationUpdate = Readonly<{ type: 'baseline'; value: CheckpointObservationSnapshot } | { type: 'events'; conversationId: string; rootContextId: string; revision: number; events: readonly CheckpointObservationEvent[] }>;

/** A bounded, passive projection. Queries never read saved IO and subscribers never run in a producer. */
export class CheckpointObservation {
  readonly #events: CheckpointObservationEvent[] = [];
  readonly #activities = new Map<string, CheckpointActivitySummary>();
  readonly #owners = new Map<string, InvocationIdentity>();
  readonly #connections = new Set<() => void>();
  readonly #notify = new Set<() => void>();
  #revision = 0;
  #truncated = false;
  #closed = false;
  constructor(
    readonly conversationId: string,
    private readonly runs: ConversationCheckpointRuns,
    private readonly limits = { events: 1024, activities: 256, owners: 2048, children: 64 },
  ) {
    for (const key of ['events', 'activities', 'owners', 'children'] as const) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > 4096) throw new TypeError('Checkpoint observation limits must be integers from 1 to 4096');
    this.limits = Object.freeze({ ...limits });
  }
  observe(fact: CheckpointFact): void {
    if (this.#closed) return;
    const owner = Object.freeze({ ...fact.owner });
    this.#owners.delete(owner.contextId);
    this.#owners.set(owner.contextId, owner);
    const rootContextId = this.root(owner.contextId);
    const event: CheckpointObservationEvent = Object.freeze({ kind: fact.kind, activityId: fact.activityId, contextId: fact.contextId, owner, recovering: fact.recovering, sequence: fact.sequence, occurredAt: fact.occurredAt, revision: ++this.#revision, ...(rootContextId ? { rootContextId } : {}), detail: project(fact, this.limits.children) });
    this.#events.push(event);
    if (this.#events.length > this.limits.events) {
      this.#events.shift();
      this.#truncated = true;
    }
    const previous = this.#activities.get(fact.activityId);
    const activity: CheckpointActivitySummary = Object.freeze({ ...previous, activityId: fact.activityId, contextId: fact.contextId, owner, recovering: fact.recovering, sequence: fact.sequence, revision: event.revision, last: fact.kind, ...(rootContextId ? { rootContextId } : {}), ...('point' in fact ? { point: fact.point } : {}), ...(fact.kind === 'installed' ? { installed: installed(fact.frame, this.limits.children) } : {}), ...(fact.kind === 'finished' ? { delivery: fact.status } : {}) });
    this.#activities.delete(activity.activityId);
    this.#activities.set(activity.activityId, activity);
    this.trim(this.#activities, this.limits.activities);
    this.trim(this.#owners, this.limits.owners);
    for (const notify of this.#notify) notify();
  }
  query(rootContextId: string): CheckpointObservationSnapshot {
    this.requireRoot(rootContextId);
    return Object.freeze({ conversationId: this.conversationId, rootContextId, revision: this.#revision, retainedFrom: this.#events[0]?.revision ?? this.#revision + 1, truncated: this.#truncated, activities: Object.freeze([...this.#activities.values()].filter((activity) => this.belongs(activity, rootContextId))), events: Object.freeze(this.#events.filter((event) => this.belongs(event, rootContextId))) });
  }
  subscribe(rootContextId: string, receive: (update: CheckpointObservationUpdate) => void): () => void {
    const baseline = this.query(rootContextId);
    let cursor = baseline.revision;
    let active = true;
    let scheduled = false;
    const close = () => {
      active = false;
      this.#connections.delete(close);
      this.#notify.delete(schedule);
    };
    const schedule = () => {
      if (!active || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (!active) return;
        try {
          const revision = this.#revision;
          if (cursor < (this.#events[0]?.revision ?? revision + 1) - 1) deliver(receive, { type: 'baseline', value: this.query(rootContextId) });
          else {
            const events = this.#events.filter((event) => event.revision > cursor && this.belongs(event, rootContextId));
            if (events.length) deliver(receive, Object.freeze({ type: 'events', conversationId: this.conversationId, rootContextId, revision, events: Object.freeze(events) }));
          }
          cursor = revision;
        } catch {
          close();
        }
      });
    };
    this.#connections.add(close);
    this.#notify.add(schedule);
    try {
      deliver(receive, Object.freeze({ type: 'baseline', value: baseline }));
    } catch (error) {
      close();
      throw error;
    }
    return close;
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const close of [...this.#connections]) close();
    this.#events.length = 0;
    this.#activities.clear();
    this.#owners.clear();
  }
  private requireRoot(rootContextId: string): void {
    if (this.#closed) throw new RuntimeError('CHECKPOINT_OBSERVATION_CLOSED', '恢复观测已关闭。');
    if (!this.runs.read(this.conversationId, rootContextId)) throw new RuntimeError('CHECKPOINT_NOT_FOUND', '该对话未登记指定的调用恢复依据。');
  }
  private belongs(value: { contextId: string; rootContextId?: string }, rootContextId: string): boolean {
    return (value.rootContextId ?? this.root(value.contextId)) === rootContextId;
  }
  private root(contextId: string): string | undefined {
    const visited = new Set<string>();
    let current = this.#owners.get(contextId);
    while (current && !visited.has(current.contextId)) {
      if (!current.parentContextId) return current.contextId;
      visited.add(current.contextId);
      const parentContextId = current.parentContextId;
      current = parentContextId ? this.#owners.get(parentContextId) : undefined;
      if (!current && parentContextId) return this.runs.read(this.conversationId, parentContextId)?.rootContextId;
    }
    return this.runs.read(this.conversationId, contextId)?.rootContextId;
  }
  private trim<Key, Value>(values: Map<Key, Value>, limit: number): void {
    if (values.size <= limit) return;
    values.delete(values.keys().next().value!);
    this.#truncated = true;
  }
}

function childSummary(child: CheckpointChild): CheckpointChildSummary {
  return Object.freeze({ owner: Object.freeze({ ...child.identity }), round: child.round, order: child.order, ...(child.key ? { key: child.key } : {}), state: child.state.kind, ...(child.state.kind === 'returned' ? { reception: child.state.reception.kind } : {}) });
}
function installed(frame: InvocationCheckpointFrame, limit: number): CheckpointInstalledSummary {
  return Object.freeze({ round: frame.round, nextChildOrder: frame.nextChildOrder, childCount: frame.children.length, truncated: frame.children.length > limit, children: Object.freeze(frame.children.slice(0, limit).map(childSummary)) });
}
function project(fact: CheckpointFact, limit: number) {
  if (fact.kind === 'captured' || fact.kind === 'saved' || fact.kind === 'checking' || fact.kind === 'continued') return Object.freeze({ checkpointId: fact.checkpointId, point: fact.point });
  if (fact.kind === 'installed') return Object.freeze({ checkpointId: fact.checkpointId, point: fact.point, baseline: installed(fact.frame, limit) });
  if (fact.kind === 'child-restored') return Object.freeze({ child: childSummary(fact.child), mode: fact.mode });
  if (fact.kind === 'finishing' || fact.kind === 'finished') return Object.freeze({ status: fact.status });
  if (fact.kind === 'failed') {
    const diagnostic = RuntimeErrorHelper.format(fact.error);
    return Object.freeze({ stage: fact.stage, ...(fact.childContextId ? { childContextId: fact.childContextId } : {}), error: Object.freeze({ code: diagnostic.code.slice(0, 128), message: diagnostic.message.slice(0, 512) }) });
  }
  if (fact.kind === 'resource') return Object.freeze({ access: fact.fact.access, supplyId: fact.fact.supplyId, sequence: fact.fact.sequence, phase: fact.fact.phase, ...(fact.fact.interactionId ? { interactionId: fact.fact.interactionId } : {}) });
  if (fact.kind === 'transcript') return Object.freeze({ transcriptId: fact.fact.transcriptId, revision: fact.fact.revision, change: fact.fact.change.kind, start: fact.fact.change.start, end: fact.fact.change.kind === 'messages-appended' ? fact.fact.change.start + fact.fact.change.messages.length : fact.fact.change.end });
  if (fact.kind === 'memory') return Object.freeze({ memoriesId: fact.fact.memoriesId, sequence: fact.fact.sequence, action: fact.fact.change.action, memoryId: fact.fact.change.memoryId });
  if (fact.kind !== 'activity') throw new Error('Unsupported checkpoint observation fact');
  const value = fact.fact;
  const description: { name?: string; label?: string } = {};
  if (value.description)
    for (const key of ['name', 'label'] as const) {
      const property = Object.getOwnPropertyDescriptor(value.description, key);
      if (property && 'value' in property && typeof property.value === 'string') description[key] = property.value.slice(0, 160);
    }
  const base = { action: value.kind, eventSequence: value.eventSequence, ...description };
  if (value.kind === 'process') return Object.freeze({ ...base, round: value.round, stage: value.process.stage, process: value.process.type });
  if (value.kind === 'relation') return Object.freeze({ ...base, childContextId: value.relation.childContextId, parentRound: value.relation.parentRound, ...(value.relation.key ? { key: value.relation.key } : {}), phase: value.change.kind, ...(value.change.kind === 'returned' ? { status: value.change.result.status } : {}) });
  if (value.kind === 'finished') return Object.freeze({ ...base, status: value.state.status });
  return Object.freeze(base);
}

function deliver(receive: (update: CheckpointObservationUpdate) => void, update: CheckpointObservationUpdate): void {
  const returned: unknown = receive(update);
  if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') {
    void Promise.resolve(returned).catch(() => undefined);
    throw new TypeError('Checkpoint observation subscribers must be synchronous');
  }
}
