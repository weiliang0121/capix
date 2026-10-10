import type { ClientState } from '@capix/client-runtime';
import type { SubmissionNotice } from '../state/data.js';
import { errorMessage } from '../lib/errors.js';

/** Public request facts and feedback health have different meanings in the interface. */
export function projectSubmission(state: ClientState): { progress: string; submissionNotice?: SubmissionNotice } {
  const submission = state.submission;
  if (!submission) return { progress: '' };
  const remote = submission.remote;
  const result = remote?.result;
  const disconnected = submission.feedback.status === 'interrupted' || submission.feedback.status === 'ended';
  const incomplete = remote?.integrity.status === 'incomplete';
  const answerPending = remote?.answer && (state.answerAvailability === 'unloaded' || state.answerAvailability === 'pending');
  const actions = { reconnect: !result && disconnected, release: !result && (disconnected || incomplete) };
  if (result && result.status !== 'completed') return { progress: '', submissionNotice: { message: `${remote?.answer ? (answerPending ? '回答已保留，正文待同步。' : '回答已保留。') : ''}${result.status === 'rejected' ? '提交被拒绝：' : '服务处理失败：'}${result.error.message}`, ...actions } };
  if (incomplete) return { progress: result ? '' : '服务可能仍在处理…', submissionNotice: { message: `本次进展无法完整确认：${remote.integrity.status === 'incomplete' ? remote.integrity.error.message : ''}`, ...actions } };
  if (!result && disconnected) return { progress: '', submissionNotice: { message: `结果待确认。${submission.feedback.status === 'interrupted' ? errorMessage(submission.feedback.error) : '已停止接收本次进展。'}`, ...actions } };
  if (submission.notificationError) return { progress: result ? '' : '正在同步本次进展…', submissionNotice: { message: `本地接纳通知处理失败：${errorMessage(submission.notificationError)}`, ...actions } };
  if (result) return { progress: answerPending ? '服务处理已完成，回答正文待同步…' : '' };
  if (submission.feedback.status === 'connecting') return { progress: remote ? '正在重新同步本次提交…' : '正在提交…' };
  if (remote?.answer) return { progress: answerPending ? '回答已落实，正文待同步；等待服务处理结果…' : '回答已落实，等待服务处理结果…' };
  return { progress: remote?.input ? '输入已接纳，正在等待回答…' : '正在确认本次提交…' };
}
