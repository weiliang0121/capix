import type { ClientState } from '@capix/client-runtime';
import type { SubmissionControl, SubmissionNotice } from '../state/data.js';
import { errorMessage } from '../lib/errors.js';

/** Public request facts and feedback health have different meanings in the interface. */
export function projectSubmission(state: Pick<ClientState, 'submission' | 'answerAvailability'>): { progress: string; submissionNotice?: SubmissionNotice; submissionControl?: SubmissionControl } {
  const submission = state.submission;
  if (!submission) return { progress: '' };
  const remote = submission.remote;
  const result = remote?.result;
  const disconnected = submission.feedback.status === 'interrupted' || submission.feedback.status === 'ended';
  const incomplete = remote?.integrity.status === 'incomplete';
  const answerPending = remote?.answer && (state.answerAvailability === 'unloaded' || state.answerAvailability === 'pending');
  const cancellation = submission.cancellation;
  const cancelling = Boolean(cancellation || remote?.cancelRequested);
  const submissionControl: SubmissionControl | undefined = result ? undefined : { id: submission.id, label: cancelling ? (cancellation?.status === 'uncertain' && !remote?.cancelRequested ? '重试停止当前回答' : '正在停止当前回答…') : '停止当前回答', disabled: cancelling && (cancellation?.status !== 'uncertain' || Boolean(remote?.cancelRequested)) };
  const actions = { reconnect: !result && (disconnected || incomplete) };
  const answer = remote?.answer ? (answerPending ? '回答已保留，正文待同步。' : '回答已保留。') : '';
  if (result?.status === 'cancelled') return { progress: '', submissionNotice: { message: `${answer}本次处理已取消。${remote?.input && !remote.answer ? '已写入的输入保留。' : ''}`, ...actions } };
  // A committed answer remains usable even if later work fails. Keep the service
  // diagnosis in runtime/observation data, not in the user's answer presentation.
  if (result?.status === 'failed' && remote?.answer) return { progress: answerPending ? '回答已生成，正文待同步…' : '' };
  if (result?.status === 'failed') return { progress: '', submissionNotice: { message: '这次未能完成回答，可以重新发送或调整问题后再试。', ...actions } };
  if (result?.status === 'rejected') return { progress: '', submissionNotice: { message: '这条消息未被接纳，可以重新发送。', ...actions } };
  if (result && cancelling) return { progress: answerPending ? '回答正文待同步…' : '', submissionNotice: { message: `${answer}处理已完成，取消没有改变已完成的结果。`, ...actions } };
  if (cancelling) {
    const message = remote?.cancelRequested || cancellation?.status === 'acknowledged' ? '服务已接收取消请求，正在等待处理实际结束。' : cancellation?.status === 'uncertain' ? `取消请求是否送达尚未确认。${cancellation.error ? errorMessage(cancellation.error) : '可以重试取消或重新同步。'}` : '已请求取消，正在确认服务端接纳。';
    const diagnostic = incomplete ? '本次进展解释不完整。' : disconnected ? '反馈已停止，请重新同步确认结果。' : '';
    return { progress: '等待取消结果…', submissionControl, submissionNotice: { message: `${answer}${message}${diagnostic}`, ...actions } };
  }
  if (incomplete) return { progress: result ? '' : '服务可能仍在处理…', submissionControl, submissionNotice: { message: `本次进展无法完整确认：${remote.integrity.status === 'incomplete' ? remote.integrity.error.message : ''}`, ...actions } };
  if (!result && disconnected) return { progress: '', submissionControl, submissionNotice: { message: `结果待确认。${submission.feedback.status === 'interrupted' ? errorMessage(submission.feedback.error) : '已停止接收本次进展。'}`, ...actions } };
  if (submission.notificationError) return { progress: result ? '' : '正在同步本次进展…', submissionControl, submissionNotice: { message: `本地接纳通知处理失败：${errorMessage(submission.notificationError)}`, ...actions } };
  if (result) return { progress: answerPending ? '服务处理已完成，回答正文待同步…' : '' };
  if (submission.feedback.status === 'connecting') return { progress: remote ? '正在重新同步本次提交…' : '正在提交…', submissionControl };
  if (remote?.answer) return { progress: answerPending ? '回答已落实，正文待同步；等待服务处理结果…' : '回答已落实，等待服务处理结果…', submissionControl };
  return { progress: remote?.input ? '输入已接纳，正在等待回答…' : '正在确认本次提交…', submissionControl };
}
