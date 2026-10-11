import type { ConversationTask, FileTask } from '@capix/protocol';
import { isEqual } from 'es-toolkit';
import { isPlainObject } from 'es-toolkit/predicate';
import { acceptFileTask } from './files.js';

/** A selected service task is cumulative; explicit client scope cannot be replaced or expanded. */
export function acceptConversationTask(next: ConversationTask | undefined, previous: ConversationTask | undefined, requested: FileTask | undefined): ConversationTask | undefined {
  if (next === undefined) {
    if (previous) throw new Error('已确定的处理任务不能丢失。');
    return undefined;
  }
  if (!isPlainObject(next) || !['reply', 'file', 'clarify', 'unsupported'].includes(next.kind)) throw new Error('处理任务类型无效。');
  const accepted = Object.freeze(next.kind === 'file' ? { kind: next.kind, task: acceptFileTask(next.task) } : { kind: next.kind });
  if (requested && (accepted.kind === 'reply' || (accepted.kind === 'file' && !isEqual(accepted.task, requested)))) throw new Error('服务确定的任务不能改变本次明确申请的文件操作。');
  if (previous && !isEqual(previous, accepted)) throw new Error('本次已确定的处理任务不能改变。');
  return accepted;
}
