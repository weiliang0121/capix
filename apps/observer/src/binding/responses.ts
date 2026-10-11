import type { ClientState, ClientSubmissionState } from '@capix/client-runtime';
import type { ConversationItem, ConversationMessage, ConversationProcess, ConversationResponse } from '../state/conversation.js';
import { projectConversationProcess } from './activities.js';
import { projectSubmission } from './submission.js';

function bodyState(submission: ClientSubmissionState, state: ClientState, body?: ConversationMessage): ConversationResponse['bodyState'] {
  const answer = submission.remote?.answer;
  if (!answer) return 'unconfirmed';
  if (body) return 'available';
  const source = state.transcripts.get(answer.transcriptId);
  if (source?.sync.status === 'failed') return 'error';
  if (source?.sync.status === 'connecting' || source?.sync.status === 'retrying') return 'pending';
  if (source?.snapshot && source.snapshot.end > answer.index) return 'missing';
  if (source?.sync.status === 'live') return 'pending';
  return source?.snapshot ? 'missing' : 'unloaded';
}

function response(submission: ClientSubmissionState, state: ClientState, body?: ConversationMessage, afterInputKey?: string): ConversationResponse {
  const remote = submission.remote;
  const result = remote?.result;
  const availability = bodyState(submission, state, body);
  const presentation = projectSubmission({ submission, answerAvailability: availability === 'available' ? 'available' : availability === 'unconfirmed' ? 'unconfirmed' : 'pending' });
  const activity = projectConversationProcess(submission);
  let process: ConversationProcess | undefined;
  if (!result && activity) process = activity;
  else if (presentation.progress) process = { id: submission.id, label: presentation.progress, active: result ? availability === 'pending' : submission.feedback.status === 'connecting' || (submission.feedback.status === 'following' && remote?.integrity.status !== 'incomplete') };
  let notice = presentation.submissionNotice;
  if (availability === 'error' || availability === 'missing' || availability === 'unloaded') {
    const detail = availability === 'error' ? '回答已生成，正文暂未同步，可以重新连接消息。' : availability === 'missing' ? '回答已落实，但本地消息集合尚未取得对应正文。' : '回答已落实，正文尚未加载。';
    if (result || !process) process = { id: submission.id, label: availability === 'error' ? '回答正文同步失败' : availability === 'missing' ? '回答正文暂不可用' : '回答正文尚未加载', active: false };
    notice = { message: [notice?.message, detail].filter(Boolean).join(' '), reconnect: notice?.reconnect ?? false };
  }
  // Once the submission has ended, call diagnostics belong to observation.
  // Body availability and the actual submission outcome retain their own notices.
  // Only the current submission has a reconnect command; retained failures remain readable.
  if (notice?.reconnect && submission.id !== state.submission?.id) notice = { ...notice, reconnect: false };
  const fileTask = remote?.task?.kind === 'file' ? remote.task.task : remote?.task ? undefined : submission.fileTask;
  return { kind: 'response', key: JSON.stringify(['response', submission.queueId]), submissionId: submission.id, queueId: submission.queueId, bodyState: availability, ...(fileTask ? { fileTask } : {}), ...(remote?.fileOutput ? { fileOutput: remote.fileOutput } : {}), ...(afterInputKey ? { afterInputKey } : {}), ...(body ? { body } : {}), ...(process ? { process } : {}), ...(notice ? { notice } : {}) };
}

/** Compose response regions from submission locators while leaving formal transcript content intact. */
export function projectResponses(messages: readonly ConversationMessage[], state: ClientState): readonly ConversationItem[] {
  // Repeated admission attempts keep one local response; the newest attempt owns its facts.
  const tracked = new Map<string, ClientSubmissionState>();
  for (const submission of state.submissions.values()) tracked.set(submission.queueId, submission);
  if (state.submission && state.submission.feedback.status !== 'idle') tracked.set(state.submission.queueId, state.submission);
  const byIndex = new Map(messages.filter((row) => row.index !== undefined).map((row) => [row.index!, row]));
  const attached = new Map<string, ConversationResponse[]>();
  const consumed = new Set<string>();
  const pending: ConversationItem[] = [];
  for (const submission of tracked.values()) {
    const input = submission.remote?.input;
    const current = submission.id === state.submission?.id;
    const result = submission.remote?.result;
    const retryAdmission = result?.status === 'rejected' && result.retry === 'admission';
    const waitingAdmission = retryAdmission && current && state.queue.waiting.some((item) => item.id === submission.queueId);
    if (retryAdmission && !waitingAdmission) continue;
    if ((!input && !current) || (input && input.transcriptId !== state.transcriptId)) continue;
    const inputRow = input ? byIndex.get(input.end - 1) : undefined;
    const answer = submission.remote?.answer;
    const candidate = answer && answer.transcriptId === state.transcriptId ? byIndex.get(answer.index) : undefined;
    const body = candidate?.message.role === 'assistant' ? candidate : undefined;
    const pendingKey = JSON.stringify(['pending-input', submission.queueId]);
    const projected = response(submission, state, body, inputRow?.key ?? (current ? pendingKey : undefined));
    const item = waitingAdmission ? { ...projected, notice: undefined, process: { id: submission.queueId, label: state.queue.blocked ?? '等待服务接纳，将自动重试', active: false } } : projected;
    if (body) consumed.add(body.key);
    if (inputRow) {
      const entries = attached.get(inputRow.key) ?? [];
      entries.push(item);
      attached.set(inputRow.key, entries);
    } else {
      if (current) pending.push({ kind: 'pending-input', key: pendingKey, submissionId: submission.id, queueId: submission.queueId, content: submission.pending, label: waitingAdmission ? '等待服务接纳' : input ? '输入已接纳，正文待同步' : result?.status === 'rejected' ? '未被接纳' : result?.status === 'cancelled' ? '已取消' : result?.status === 'failed' ? '处理失败' : result?.status === 'completed' ? '处理已完成' : submission.feedback.status === 'interrupted' || submission.feedback.status === 'ended' ? '提交待确认' : '等待接纳' });
      pending.push(item);
    }
  }
  const result: ConversationItem[] = [];
  for (const message of messages) {
    if (!consumed.has(message.key)) result.push({ kind: 'message', ...message });
    result.push(...(attached.get(message.key) ?? []));
  }
  result.push(...pending);
  return result;
}
