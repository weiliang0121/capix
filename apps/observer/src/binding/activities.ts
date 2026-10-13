import type { ClientSubmissionState } from '@capix/client-runtime';
import { findLast } from 'es-toolkit/compat';
import type { ConversationActivity, ConversationActivities } from '@capix/protocol';
import type { ConversationProcess } from '../state/conversation.js';

const activityLabels = new WeakMap<ConversationActivities, string>();

/** Prefer the owning operation's purpose; an A describes the current step within it. */
function currentActivity(activities: ConversationActivities): string {
  const cached = activityLabels.get(activities);
  if (cached !== undefined) return cached;
  const label = describeActivity(activities.calls);
  activityLabels.set(activities, label);
  return label;
}

function describeActivity(calls: readonly ConversationActivity[]): string {
  const current = findLast(calls, (call) => call.status === 'running');
  if (!current) return '等待处理结果';
  const byId = new Map(calls.map((call) => [call.contextId, call]));
  let ancestor: ConversationActivity | undefined = current;
  let operation: ConversationActivity | undefined;
  let round = current.round;
  const visited = new Set<string>();
  for (; ancestor && !visited.has(ancestor.contextId); ancestor = ancestor.parentContextId ? byId.get(ancestor.parentContextId) : undefined) {
    visited.add(ancestor.contextId);
    if (ancestor.level === 'operation' && !operation) operation = ancestor;
    round = Math.max(round, ancestor.round);
  }
  const purpose = operation?.label ?? (current.level === 'attempt' ? current.label : current.level === 'execution' ? '处理本轮对话' : '处理本次请求');
  const retry = round > 1 ? `（第 ${round} 次尝试）` : '';
  if (current.phase === 'handling') return `${purpose} · 正在处理异常${retry}`;
  if (current.phase === 'control') return `${purpose} · 正在结束当前调用${retry}`;
  if (current.phase === 'receive') return `${purpose} · 正在处理结果${retry}`;
  if (current.phase === 'setup') return `${purpose} · 准备中${retry}`;
  // A returned result still needs its parent's handling. It does not finish the submission.
  const child = findLast(calls, (call) => call.parentContextId === current.contextId);
  if (child && child.status !== 'running' && child.relation?.phase !== 'accepted') {
    if (child.relation?.phase === 'failed') return `${purpose} · 正在处理结果接纳失败${retry}`;
    if (child.relation?.returned === 'failed' || child.status === 'failed') return `${purpose} · 正在处理调用失败${retry}`;
    if (child.relation?.returned === 'cancelled' || child.status === 'cancelled') return `${purpose} · 正在处理调用取消${retry}`;
    if (child.relation?.phase === 'receiving' || child.relation?.phase === 'returned') return `${purpose} · 正在处理结果${retry}`;
  }
  const step = operation && current !== operation ? ` · ${current.label}` : '';
  return `正在${purpose}${step}${retry}`;
}

export function projectConversationProcess(submission: ClientSubmissionState): ConversationProcess | undefined {
  const remote = submission.remote;
  const activities = remote?.activities;
  if (!activities || (!activities.calls.length && activities.integrity.status === 'complete')) return undefined;
  const result = remote.result;
  const interrupted = !result && (submission.feedback.status === 'interrupted' || submission.feedback.status === 'ended');
  const synchronizing = !result && submission.feedback.status === 'connecting';
  const incomplete = activities.integrity.status === 'incomplete';
  const cancelling = Boolean(submission.cancellation || remote.cancelRequested);
  const active = !result && submission.feedback.status === 'following' && !incomplete;
  const current = currentActivity(activities);
  const label = result?.status === 'completed' ? '处理完成' : result?.status === 'cancelled' ? '处理已取消' : result?.status === 'rejected' ? '提交被拒绝' : result?.status === 'failed' ? (remote.answer ? '回答已保留，后续处理失败' : '处理失败') : interrupted ? '连接中断，结果待确认' : incomplete ? '过程状态暂不可用' : synchronizing ? '正在同步处理状态' : cancelling ? '等待取消结果' : current;
  const warnings = [];
  if (incomplete) warnings.push(`过程信息不完整：${activities.integrity.status === 'incomplete' ? activities.integrity.error.message : ''}`);
  if (!result && (interrupted || synchronizing || incomplete) && activities.calls.length) warnings.push(`最后收到的进展：${current}。`);
  if (result && activities.calls.some((call) => call.status === 'running')) warnings.push('部分调用的结束状态尚未取得。');
  return { id: submission.id, label, active, ...(warnings.length ? { notice: warnings.join(' ') } : {}) };
}
