import { isEqual } from 'es-toolkit';
import { callableKinds, invocationProcessStages, type ConversationActivities, type ConversationActivity, type ConversationActivityChange } from '@capix/protocol';

const indexes = new WeakMap<ConversationActivities, ReadonlyMap<string, number>>();

/** Full baselines validate every entry, including immutable prefixes and source integrity. */
export function acceptActivities(next: ConversationActivities | undefined, previous?: ConversationActivities): ConversationActivities | undefined {
  if (!next) {
    if (previous) throw new Error('处理过程来源不能消失。');
    return undefined;
  }
  if (!Array.isArray(next.calls) || next.calls.length > 512) throw new Error('处理过程格式无效。');
  const integrity = acceptIntegrity(next.integrity, previous?.integrity);
  const positions = new Map<string, number>();
  const calls: ConversationActivity[] = [];
  for (const call of next.calls) {
    if (!call || positions.has(call.contextId)) throw new Error('处理过程调用身份重复。');
    const parentPosition = call.parentContextId ? positions.get(call.parentContextId) : undefined;
    assertCall(call, parentPosition === undefined ? undefined : calls[parentPosition]);
    const before = previous?.calls[calls.length];
    if (before) assertProgress(before, call);
    const accepted = copyCall(call);
    positions.set(call.contextId, calls.length);
    calls.push(before && isEqual(before, accepted) ? before : accepted);
  }
  if (previous && calls.length < previous.calls.length) throw new Error('处理过程既有调用发生回退或改变。');
  const accepted = Object.freeze({ calls: Object.freeze(calls), integrity });
  if (previous?.integrity.status === 'incomplete' && !isEqual(previous, accepted)) throw new Error('不完整的处理过程来源不能恢复或继续变更。');
  if (previous && isEqual(previous, accepted)) return previous;
  indexes.set(accepted, positions);
  return accepted;
}

/** Delta acceptance checks only changed entries; existing call objects and indexes are reused. */
export function acceptActivityChange(change: ConversationActivityChange, previous?: ConversationActivities): ConversationActivities {
  if (!change || typeof change !== 'object' || (change.calls !== undefined && (!Array.isArray(change.calls) || change.calls.length > 512))) throw new Error('处理过程增量格式无效。');
  if (!previous && !change.integrity) throw new Error('处理过程增量缺少初始完整性。');
  const integrity = change.integrity === undefined ? previous!.integrity : acceptIntegrity(change.integrity, previous?.integrity);
  let positions = previous ? indexes.get(previous) : new Map<string, number>();
  if (!positions) throw new Error('处理过程索引缺失。');
  let calls = previous?.calls ?? [];
  let mutableCalls: ConversationActivity[] | undefined;
  let mutablePositions: Map<string, number> | undefined;
  const seen = new Set<string>();
  for (const call of change.calls ?? []) {
    if (!call || seen.has(call.contextId)) throw new Error('处理过程增量调用身份重复。');
    seen.add(call.contextId);
    const position = positions.get(call.contextId);
    const parentPosition = call.parentContextId ? positions.get(call.parentContextId) : undefined;
    assertCall(call, parentPosition === undefined ? undefined : calls[parentPosition]);
    const before = position === undefined ? undefined : calls[position];
    if (before) assertProgress(before, call);
    const accepted = copyCall(call);
    if (before && isEqual(before, accepted)) continue;
    if (previous?.integrity.status === 'incomplete') throw new Error('不完整的处理过程来源不能恢复或继续变更。');
    if (!mutableCalls) {
      mutableCalls = [...calls];
      calls = mutableCalls;
    }
    if (position === undefined) {
      if (calls.length >= 512) throw new Error('处理过程调用数量超限。');
      if (!mutablePositions) {
        mutablePositions = new Map(positions);
        positions = mutablePositions;
      }
      mutablePositions.set(call.contextId, calls.length);
      mutableCalls.push(accepted);
    } else mutableCalls[position] = accepted;
  }
  if (previous && calls === previous.calls && integrity === previous.integrity) return previous;
  const accepted = Object.freeze({ calls: Object.freeze(calls), integrity });
  indexes.set(accepted, positions);
  return accepted;
}

function acceptIntegrity(next: ConversationActivities['integrity'], previous?: ConversationActivities['integrity']): ConversationActivities['integrity'] {
  if (!next || !['complete', 'incomplete'].includes(next.status)) throw new Error('处理过程格式无效。');
  if (next.status === 'incomplete' && (!next.error || typeof next.error.code !== 'string' || !next.error.code || typeof next.error.message !== 'string')) throw new Error('处理过程完整性诊断无效。');
  const accepted = next.status === 'incomplete' ? Object.freeze({ status: 'incomplete' as const, error: Object.freeze({ code: next.error.code, message: next.error.message }) }) : Object.freeze({ status: 'complete' as const });
  if (previous && isEqual(previous, accepted)) return previous;
  if (previous?.status === 'incomplete') throw new Error('不完整的处理过程来源不能恢复或继续变更。');
  return accepted;
}

function assertCall(call: ConversationActivity, parent?: ConversationActivity): void {
  if (!call || typeof call.contextId !== 'string' || !call.contextId || !callableKinds.includes(call.kind) || typeof call.label !== 'string' || !call.label || call.label.length > 120 || !['running', 'succeeded', 'failed', 'cancelled'].includes(call.status) || !['setup', ...invocationProcessStages].includes(call.phase) || !Number.isSafeInteger(call.round) || call.round < 0 || call.round > 2) throw new Error('处理过程调用身份或状态无效。');
  if ((call.startedAt !== undefined && !validTime(call.startedAt)) || (call.finishedAt !== undefined && !validTime(call.finishedAt)) || (call.status === 'running' ? call.finishedAt !== undefined : !call.finishedAt)) throw new Error('处理过程调用边界无效。');
  if (call.parentContextId === undefined ? call.relation !== undefined : !parent || !allowsChild(parent.kind, call.kind)) throw new Error('处理过程父子归属无效。');
  if (call.relation) {
    const { phase, returned } = call.relation;
    if (!['attached', 'returned', 'receiving', 'accepted', 'handled', 'failed'].includes(phase) || (returned !== undefined && !['succeeded', 'failed', 'cancelled'].includes(returned)) || (phase === 'accepted' && returned !== 'succeeded') || (phase === 'handled' && returned !== 'failed') || (['receiving', 'failed'].includes(phase) && returned !== 'succeeded' && returned !== 'failed') || (phase === 'returned' && !returned)) throw new Error('处理过程父层接纳状态无效。');
  }
}

function assertProgress(before: ConversationActivity, after: ConversationActivity): void {
  if (before.contextId !== after.contextId || before.parentContextId !== after.parentContextId || before.kind !== after.kind || before.label !== after.label || (before.startedAt !== undefined && before.startedAt !== after.startedAt) || after.round < before.round) throw new Error('处理过程既有调用发生回退或改变。');
  if (before.status === 'running' && (after.round === before.round ? !phaseCanAdvance(before.phase, after.phase) : before.phase === 'control' || after.phase === 'setup')) throw new Error('处理过程阶段发生回退。');
  if (before.status !== 'running' && (before.status !== after.status || before.finishedAt !== after.finishedAt || before.round !== after.round || before.phase !== after.phase)) throw new Error('已结束的调用不能重新运行或改写结果。');
  if (before.relation && (!after.relation || (before.relation.returned && before.relation.returned !== after.relation.returned) || !relationCanAdvance(before.relation.phase, after.relation.phase))) throw new Error('父层接纳事实发生回退或改变。');
}

function copyCall(call: ConversationActivity): ConversationActivity {
  return Object.freeze({ contextId: call.contextId, ...(call.parentContextId ? { parentContextId: call.parentContextId } : {}), kind: call.kind, label: call.label, status: call.status, phase: call.phase, round: call.round, ...(call.startedAt ? { startedAt: call.startedAt } : {}), ...(call.finishedAt ? { finishedAt: call.finishedAt } : {}), ...(call.relation ? { relation: Object.freeze({ phase: call.relation.phase, ...(call.relation.returned ? { returned: call.relation.returned } : {}) }) } : {}) });
}

function validTime(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function allowsChild(parent: ConversationActivity['kind'], child: ConversationActivity['kind']): boolean {
  return parent !== 'node' && child !== 'scene';
}

function relationCanAdvance(before: NonNullable<ConversationActivity['relation']>['phase'], after: NonNullable<ConversationActivity['relation']>['phase']): boolean {
  if (before === after) return true;
  if (before === 'accepted' || before === 'handled' || before === 'failed') return false;
  if (before === 'receiving') return after === 'accepted' || after === 'handled' || after === 'failed';
  if (before === 'returned') return after !== 'attached';
  return true;
}

/** Snapshots can skip intermediate actions, but a new execute phase needs a new round. */
function phaseCanAdvance(before: ConversationActivity['phase'], after: ConversationActivity['phase']): boolean {
  if (before === after || before === 'setup') return true;
  if (before === 'control' || after === 'setup' || after === 'execute') return false;
  if (before === 'handling') return after === 'control';
  return true;
}
