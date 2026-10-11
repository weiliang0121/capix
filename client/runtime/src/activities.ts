import { isEqual } from 'es-toolkit';
import { invocationLevels, invocationProcessStages, type ConversationActivities, type ConversationActivity } from '@capix/protocol';

/** Accept service-owned call states. This receiver never interprets records or schedules work. */
export function acceptActivities(next: ConversationActivities | undefined, previous?: ConversationActivities): ConversationActivities | undefined {
  if (!next) {
    if (previous) throw new Error('处理过程来源不能消失。');
    return undefined;
  }
  if (!Array.isArray(next.calls) || next.calls.length > 512 || !next.integrity || !['complete', 'incomplete'].includes(next.integrity.status)) throw new Error('处理过程格式无效。');
  if (next.integrity.status === 'incomplete' && (!next.integrity.error || typeof next.integrity.error.code !== 'string' || !next.integrity.error.code || typeof next.integrity.error.message !== 'string')) throw new Error('处理过程完整性诊断无效。');
  const calls = new Map<string, ConversationActivity>();
  for (const call of next.calls) {
    if (!call || typeof call.contextId !== 'string' || !call.contextId || calls.has(call.contextId) || !invocationLevels.includes(call.level) || typeof call.label !== 'string' || !call.label || call.label.length > 120 || !['running', 'succeeded', 'failed', 'cancelled'].includes(call.status) || !['setup', ...invocationProcessStages].includes(call.phase) || !Number.isSafeInteger(call.round) || call.round < 0 || call.round > 2) throw new Error('处理过程调用身份或状态无效。');
    if ((call.startedAt !== undefined && !validTime(call.startedAt)) || (call.finishedAt !== undefined && !validTime(call.finishedAt)) || (call.status === 'running' ? call.finishedAt !== undefined : !call.finishedAt)) throw new Error('处理过程调用边界无效。');
    const parent = call.parentContextId ? calls.get(call.parentContextId) : undefined;
    if (call.level === 'runtime' ? call.parentContextId !== undefined || call.relation !== undefined : !parent || !allowsChild(parent.level, call.level)) throw new Error('处理过程父子归属无效。');
    if (call.relation && (!['attached', 'returned', 'receiving', 'accepted', 'failed'].includes(call.relation.phase) || (call.relation.returned !== undefined && !['succeeded', 'failed', 'cancelled'].includes(call.relation.returned)) || (['receiving', 'accepted', 'failed'].includes(call.relation.phase) && call.relation.returned !== 'succeeded') || (call.relation.phase === 'returned' && !call.relation.returned))) throw new Error('处理过程父层接纳状态无效。');
    calls.set(call.contextId, call);
  }
  const accepted: ConversationActivities = Object.freeze({
    calls: Object.freeze(next.calls.map((call) => Object.freeze({ contextId: call.contextId, ...(call.parentContextId ? { parentContextId: call.parentContextId } : {}), level: call.level, label: call.label, status: call.status, phase: call.phase, round: call.round, ...(call.startedAt ? { startedAt: call.startedAt } : {}), ...(call.finishedAt ? { finishedAt: call.finishedAt } : {}), ...(call.relation ? { relation: Object.freeze({ phase: call.relation.phase, ...(call.relation.returned ? { returned: call.relation.returned } : {}) }) } : {}) }))),
    integrity: next.integrity.status === 'incomplete' ? Object.freeze({ status: 'incomplete', error: Object.freeze({ code: next.integrity.error.code, message: next.integrity.error.message }) }) : Object.freeze({ status: 'complete' }),
  });
  if (previous) {
    if (previous.integrity.status === 'incomplete' && !isEqual(previous, accepted)) throw new Error('不完整的处理过程来源不能恢复或继续变更。');
    for (const [index, before] of previous.calls.entries()) {
      const after = next.calls[index];
      if (!after || before.contextId !== after.contextId || before.parentContextId !== after.parentContextId || before.level !== after.level || before.label !== after.label || (before.startedAt !== undefined && before.startedAt !== after.startedAt) || after.round < before.round) throw new Error('处理过程既有调用发生回退或改变。');
      if (before.status === 'running' && (after.round === before.round ? !phaseCanAdvance(before.phase, after.phase) : before.phase === 'control' || after.phase === 'setup')) throw new Error('处理过程阶段发生回退。');
      if (before.status !== 'running' && (before.status !== after.status || before.finishedAt !== after.finishedAt || before.round !== after.round || before.phase !== after.phase)) throw new Error('已结束的调用不能重新运行或改写结果。');
      if (before.relation && (!after.relation || (before.relation.returned && before.relation.returned !== after.relation.returned) || !relationCanAdvance(before.relation.phase, after.relation.phase))) throw new Error('父层接纳事实发生回退或改变。');
    }
  }
  return accepted;
}

function validTime(value: string): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function allowsChild(parent: ConversationActivity['level'], child: ConversationActivity['level']): boolean {
  return (parent === 'runtime' && child === 'execution') || (parent === 'execution' && child === 'operation') || (parent === 'operation' && (child === 'operation' || child === 'attempt'));
}

function relationCanAdvance(before: NonNullable<ConversationActivity['relation']>['phase'], after: NonNullable<ConversationActivity['relation']>['phase']): boolean {
  if (before === after) return true;
  if (before === 'accepted' || before === 'failed') return false;
  if (before === 'receiving') return after === 'accepted' || after === 'failed';
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
