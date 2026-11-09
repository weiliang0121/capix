import type { ConversationActivities, ConversationActivity, ConversationActivityChange } from '@weiliang0121/capix-protocol';
import type { InvocationProgress } from '@weiliang0121/capix-invocation';

const labels = { scene: '场景', group: '组合处理', node: '直接处理' } as const;
const maximumCalls = 512;

/** A bounded service projection of passive call facts, independent of records and formal content. */
export class ConversationActivityProjection {
  private readonly calls = new Map<string, ConversationActivity>();
  private readonly sequences = new Map<string, number>();
  private readonly relations = new Map<string, { readonly parentContextId: string; readonly value: NonNullable<ConversationActivity['relation']> }>();
  private readonly positions = new Set<string>();
  private integrity: ConversationActivities['integrity'] = Object.freeze({ status: 'complete' });
  private state?: ConversationActivities;

  constructor(private readonly changed: (change: ConversationActivityChange) => void) {}

  get snapshot(): ConversationActivities {
    return (this.state ??= Object.freeze({ calls: Object.freeze([...this.calls.values()]), integrity: this.integrity }));
  }

  receive(fact: InvocationProgress): undefined {
    if (this.integrity.status === 'incomplete') return;
    const identity = fact.identity;
    const previousSequence = this.sequences.get(identity.contextId) ?? 0;
    if (fact.eventSequence <= previousSequence) throw new Error('Activity facts must advance their call-local sequence');
    const previous = this.calls.get(identity.contextId);
    if (previous && (previous.kind !== identity.kind || previous.parentContextId !== identity.parentContextId)) throw new Error('Activity call identity changed');
    if (identity.parentContextId && !this.calls.has(identity.parentContextId)) throw new Error('Activity parent is missing');
    this.reserve(identity.contextId);
    this.sequences.set(identity.contextId, fact.eventSequence);
    if (fact.kind === 'relation') {
      if (!previous || identity.contextId !== fact.relation.parentContextId) throw new Error('Activity relation does not belong to its parent');
      const childId = fact.relation.childContextId;
      this.reserve(childId);
      const child = this.calls.get(childId);
      const relation = this.relations.get(childId);
      if (child && child.parentContextId !== identity.contextId) throw new Error('Activity relation points to another parent');
      if (relation && relation.parentContextId !== identity.contextId) throw new Error('Activity relation changed parent');
      if (fact.phase !== 'attached' && !relation) throw new Error('Activity relation was not attached');
      const value = Object.freeze({ phase: fact.phase, ...(fact.phase === 'returned' ? { returned: fact.status } : relation?.value.returned ? { returned: relation.value.returned } : {}) });
      this.relations.set(childId, { parentContextId: identity.contextId, value });
      if (child && (child.relation?.phase !== value.phase || child.relation.returned !== value.returned)) this.install(Object.freeze({ ...child, relation: value }));
      return;
    }
    const relation = this.relations.get(identity.contextId);
    if (relation && relation.parentContextId !== identity.parentContextId) throw new Error('Activity call does not match its attached relation');
    const initial: ConversationActivity = previous ?? {
      contextId: identity.contextId,
      ...(identity.parentContextId ? { parentContextId: identity.parentContextId } : {}),
      kind: identity.kind,
      label: (fact.description?.label || fact.description?.name || labels[identity.kind]).slice(0, 120),
      status: 'running',
      phase: 'setup',
      round: 0,
      ...(relation ? { relation: relation.value } : {}),
    };
    if (previous && previous.status !== 'running') throw new Error('Activity changed after finishing');
    if (fact.kind === 'started') {
      if (previous?.startedAt) throw new Error('Activity started twice');
      this.install(Object.freeze({ ...initial, startedAt: fact.occurredAt }));
    } else if (fact.kind === 'process') {
      if (!previous?.startedAt || fact.round < previous.round) throw new Error('Activity process has no valid start or round');
      // Multiple boundary actions can describe the same public phase. Their sequence is
      // still checked above, but they do not change the service projection.
      if (previous.phase !== fact.stage || previous.round !== fact.round) this.install(Object.freeze({ ...initial, phase: fact.stage, round: fact.round }));
    } else {
      this.install(Object.freeze({ ...initial, status: fact.status, finishedAt: fact.occurredAt }));
    }
  }

  invalidate(_error: unknown): undefined {
    if (this.integrity.status === 'incomplete') return;
    this.integrity = Object.freeze({ status: 'incomplete', error: Object.freeze({ code: 'ACTIVITY_INCOMPLETE', message: '处理过程信息不完整；提交结果和消息同步仍独立更新。' }) });
    this.state = undefined;
    this.changed(Object.freeze({ integrity: this.integrity }));
  }

  private reserve(id: string): void {
    if (this.positions.has(id)) return;
    if (this.positions.size >= maximumCalls) throw new Error('Submission activity capacity reached');
    this.positions.add(id);
  }

  private install(call: ConversationActivity): void {
    this.calls.set(call.contextId, call);
    this.state = undefined;
    this.changed(Object.freeze({ calls: Object.freeze([call]) }));
  }
}
