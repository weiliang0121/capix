import type { ClientState, ClientSubmissionState } from '@capix/client-runtime';
import type { ConversationItem, ConversationMessage, ConversationProcess, ConversationResponse, ConversationResponseContent } from '../state/conversation.js';
import { projectConversationProcess } from './activities.js';
import { projectSubmission, submissionPresentationKey } from './submission.js';

/** Both facts explicitly identify a formal message; neither is inferred from text or adjacency. */
export function responseLocator(submission: ClientSubmissionState) {
  if (submission.remote?.answer) return submission.remote.answer;
  const preview = submission.preview;
  return preview?.status === 'live' && preview.snapshot?.state === 'committed' ? preview.snapshot.message : undefined;
}

function bodyState(submission: ClientSubmissionState, state: ClientState, body?: ConversationMessage): ConversationResponse['bodyState'] {
  const answer = responseLocator(submission);
  if (!answer) return 'unconfirmed';
  if (body) return 'available';
  const source = state.transcripts.get(answer.transcriptId);
  if (source?.sync.status === 'failed') return 'error';
  if (source?.sync.status === 'connecting' || source?.sync.status === 'retrying') return 'pending';
  if (source?.snapshot && source.snapshot.end > answer.index) return 'missing';
  if (source?.sync.status === 'live') return 'pending';
  return source?.snapshot ? 'missing' : 'unloaded';
}

function previewMatches(submission: ClientSubmissionState, transcriptId: string | undefined, body: ConversationMessage): boolean {
  const preview = submission.preview?.snapshot;
  const answer = responseLocator(submission);
  if (submission.preview?.status !== 'live' || preview?.state !== 'committed' || preview.message?.transcriptId !== transcriptId || preview.message?.index !== body.index || answer?.transcriptId !== transcriptId || answer?.index !== body.index) return false;
  return preview.consistency === 'complete' ? body.message.content === preview.text : preview.consistency === 'prefix' && body.message.content.startsWith(preview.text);
}

function content(submission: ClientSubmissionState, transcriptId: string | undefined, availability: ConversationResponse['bodyState'], body?: ConversationMessage): ConversationResponseContent | undefined {
  const preview = submission.preview?.snapshot;
  if (body) {
    // A body shown before its locator is history; do not replay it when the feedback catches up.
    const continuePreview = preview && previewMatches(submission, transcriptId, body) && body.reveal;
    return { key: continuePreview ? JSON.stringify(['preview', submission.id, preview.generation]) : body.key, text: body.message.content, complete: true, reveal: preview ? !!continuePreview : !!body.reveal, provisional: false };
  }
  if (!preview) return;
  return {
    key: JSON.stringify(['preview', submission.id, preview.generation]),
    text: preview.text,
    complete: preview.state === 'committed' ? preview.consistency !== 'prefix' || availability === 'error' || availability === 'missing' : preview.state === 'discarded' || !!submission.remote?.result,
    reveal: true,
    provisional: true,
  };
}

function previewNotice(submission: ClientSubmissionState, transcriptId: string | undefined, body?: ConversationMessage): string | undefined {
  if (body) return submission.preview?.snapshot && !previewMatches(submission, transcriptId, body) ? '已更新为正式接纳的回答。' : undefined;
  const preview = submission.preview;
  if (!preview?.snapshot) return;
  if (preview.snapshot.state === 'discarded') return preview.snapshot.reason === 'cancelled' ? '生成已停止，以上内容未作为正式回答保存。' : '以上生成内容未被接纳为正式回答。';
  if (preview.snapshot.state === 'committed') return '回答已接纳，正在同步正式正文。';
  if (submission.remote?.result) return '以上生成内容未被确认为正式回答。';
  if (preview.status === 'failed') return '回答预览暂不可用，已接收内容保留，正在等待正式回答。';
  if (preview.status === 'interrupted') return '回答预览同步中断，已接收内容保留。';
}

function response(submission: ClientSubmissionState, state: ClientState, body?: ConversationMessage, afterInputKey?: string): ConversationResponse {
  const remote = submission.remote;
  const result = remote?.result;
  const availability = bodyState(submission, state, body);
  const presentation = projectSubmission({ submission, queue: state.queue, answerAvailability: availability === 'available' ? 'available' : availability === 'unconfirmed' ? 'unconfirmed' : 'pending' });
  const activity = result || submission.feedback.status === 'unavailable' ? undefined : projectConversationProcess(submission);
  let process: ConversationProcess | undefined;
  if (!result && activity) process = activity;
  else if (presentation.progress) process = { id: submission.id, label: presentation.progress, active: result ? availability === 'pending' : submission.feedback.status === 'connecting' || (submission.feedback.status === 'following' && remote?.integrity.status !== 'incomplete') };
  let notice = presentation.submissionNotice;
  const previewMessage = previewNotice(submission, state.transcriptId, body);
  if (previewMessage) notice = { ...notice, message: [notice?.message, previewMessage].filter(Boolean).join(' '), reconnect: notice?.reconnect ?? false };
  if (availability === 'error' || availability === 'missing' || availability === 'unloaded') {
    const detail = availability === 'error' ? '回答已生成，正文暂未同步，可以重新连接消息。' : availability === 'missing' ? '回答已落实，但本地消息集合尚未取得对应正文。' : '回答已落实，正文尚未加载。';
    if (result || !process) process = { id: submission.id, label: availability === 'error' ? '回答正文同步失败' : availability === 'missing' ? '回答正文暂不可用' : '回答正文尚未加载', active: false };
    notice = { ...notice, message: [notice?.message, detail].filter(Boolean).join(' '), reconnect: notice?.reconnect ?? false };
  }
  // Once the submission has ended, call diagnostics belong to observation.
  // Body availability and the actual submission outcome retain their own notices.
  // Only the current submission has a reconnect command; retained failures remain readable.
  if (notice && submission.id !== state.submission?.id) notice = { ...notice, reconnect: false, abandon: false };
  const fileTask = remote?.task?.kind === 'file' ? remote.task.task : remote?.task ? undefined : submission.fileTask;
  const display = content(submission, state.transcriptId, availability, body);
  return { kind: 'response', key: submissionPresentationKey(submission), submissionId: submission.id, queueId: submission.queueId, bodyState: availability, ...(fileTask ? { fileTask } : {}), ...(remote?.fileOutput ? { fileOutput: remote.fileOutput } : {}), ...(afterInputKey ? { afterInputKey } : {}), ...(body ? { body } : {}), ...(display ? { content: display } : {}), ...(process ? { process } : {}), ...(notice ? { notice } : {}) };
}

/** Retain unchanged history and formal indexes across preview-only browser frames. */
export function createResponseProjection() {
  let previousMessages: readonly ConversationMessage[] | undefined;
  let byIndex = new Map<number, ConversationMessage>();
  const messageItems = new WeakMap<ConversationMessage, ConversationItem>();
  const responses = new Map<string, { dependencies: readonly unknown[]; value: ConversationResponse }>();
  return (messages: readonly ConversationMessage[], state: ClientState): readonly ConversationItem[] => {
    if (messages !== previousMessages) {
      byIndex = new Map(messages.filter((row) => row.index !== undefined).map((row) => [row.index!, row]));
      previousMessages = messages;
    }
    const retained = new Set<string>();
    const result = composeResponses(
      messages,
      state,
      byIndex,
      (submission, current, body, afterInputKey) => {
        retained.add(submission.id);
        const answer = responseLocator(submission);
        const source = answer ? current.transcripts.get(answer.transcriptId) : undefined;
        const dependencies = [submission, current.transcriptId, current.submission?.id, submission.feedback.status === 'unavailable' && Boolean(current.queue.waiting.length), source, body, afterInputKey];
        const cached = responses.get(submission.id);
        if (cached && dependencies.every((value, index) => value === cached.dependencies[index])) return cached.value;
        const value = response(submission, current, body, afterInputKey);
        responses.set(submission.id, { dependencies, value });
        return value;
      },
      (message) => {
        let item = messageItems.get(message);
        if (!item) {
          item = { kind: 'message', ...message };
          messageItems.set(message, item);
        }
        return item;
      },
    );
    for (const id of responses.keys()) if (!retained.has(id)) responses.delete(id);
    return result;
  };
}

function composeResponses(messages: readonly ConversationMessage[], state: ClientState, byIndex: ReadonlyMap<number, ConversationMessage>, projectResponse: typeof response, projectMessage: (message: ConversationMessage) => ConversationItem): readonly ConversationItem[] {
  // Repeated admission attempts keep one local response; the newest attempt owns its facts.
  const tracked = new Map<string, ClientSubmissionState>();
  for (const submission of state.submissions.values()) tracked.set(submissionPresentationKey(submission), submission);
  if (state.submission && state.submission.feedback.status !== 'idle') tracked.set(submissionPresentationKey(state.submission), state.submission);
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
    const answer = responseLocator(submission);
    const candidate = answer && answer.transcriptId === state.transcriptId ? byIndex.get(answer.index) : undefined;
    const body = candidate?.message.role === 'assistant' ? candidate : undefined;
    const pendingKey = JSON.stringify(['pending-input', submission.queueId]);
    const pendingInput = current && submission.queueId !== undefined && submission.pending !== undefined;
    const projected = projectResponse(submission, state, body, inputRow?.key ?? (pendingInput ? pendingKey : undefined));
    const item = waitingAdmission ? { ...projected, notice: undefined, process: { id: submission.id, label: state.queue.blocked ?? '等待服务接纳，将自动重试', active: false } } : projected;
    if (body) consumed.add(body.key);
    if (inputRow) {
      const entries = attached.get(inputRow.key) ?? [];
      entries.push(item);
      attached.set(inputRow.key, entries);
    } else {
      if (pendingInput) pending.push({ kind: 'pending-input', key: pendingKey, submissionId: submission.id, queueId: submission.queueId!, content: submission.pending!, label: waitingAdmission ? '等待服务接纳' : input ? '输入已接纳，正文待同步' : result?.status === 'rejected' ? '未被接纳' : result?.status === 'cancelled' ? '已取消' : result?.status === 'failed' ? '处理失败' : result?.status === 'completed' ? '处理已完成' : submission.feedback.status === 'interrupted' || submission.feedback.status === 'ended' || submission.feedback.status === 'unavailable' ? '提交待确认' : '等待接纳' });
      pending.push(item);
    }
  }
  const result: ConversationItem[] = [];
  for (const message of messages) {
    if (!consumed.has(message.key)) result.push(projectMessage(message));
    result.push(...(attached.get(message.key) ?? []));
  }
  result.push(...pending);
  return result;
}
