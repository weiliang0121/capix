import type { ConversationStage } from '@capix/protocol';

/** Stage metadata is a disposable current projection, never a result or recovered history. */
export function acceptStage(next: ConversationStage | undefined, previous?: ConversationStage): ConversationStage | undefined {
  if (!next) {
    if (previous) throw new Error('提交阶段不能消失。');
    return undefined;
  }
  if (typeof next.contextId !== 'string' || !next.contextId || next.contextId.length > 256 || !['model', 'tool'].includes(next.kind) || typeof next.label !== 'string' || !next.label || next.label.length > 120 || !['running', 'succeeded', 'failed', 'cancelled'].includes(next.status)) throw new Error('提交阶段格式无效。');
  if (previous?.contextId === next.contextId && (previous.kind !== next.kind || previous.label !== next.label || (previous.status !== 'running' && previous.status !== next.status))) throw new Error('提交阶段改写了已发生的事实。');
  return Object.freeze({ contextId: next.contextId, kind: next.kind, label: next.label, status: next.status });
}
