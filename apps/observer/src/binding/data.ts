import type { ClientState } from '@capix/client-runtime';
import type { ObserverOverview } from '@capix/protocol';
import { projectConversation } from '../observation/conversation.js';
import { emptyAppData } from '../state/data.js';
import type { AppData } from '../state/data.js';
import { createObservationProjection } from './observation.js';
import { projectSubmission } from './submission.js';
import { projectResponses } from './responses.js';
import { createRevealProjection } from './reveal.js';
import type { ConversationMessage } from '../state/conversation.js';

function projectConversationSync(state: ClientState): AppData['conversationSync'] {
  const transcript = state.transcriptId ? state.transcripts.get(state.transcriptId) : undefined;
  const sync = transcript?.sync;
  if (!sync || sync.status === 'live') {
    if (state.initialization.status === 'running') return { message: '正在建立对话连接…', reconnect: false };
    if (state.initialization.status === 'failed') return { message: '对话连接未能建立，请重新连接。', reconnect: true };
    if (state.initialization.status === 'stopped') return { message: '对话连接已停止。', reconnect: true };
    return;
  }
  if (sync.status === 'connecting') return { message: transcript?.snapshot ? '正在重新连接消息…' : '正在同步消息…', reconnect: false };
  if (sync.status === 'retrying') return { message: '消息连接中断，正在自动重连…', reconnect: false };
  if (sync.status === 'failed') return { message: '消息同步暂不可用，可以重新连接。已接收的消息仍然保留。', reconnect: true };
  if (sync.status === 'stopped') return { message: '消息同步已停止。已接收的消息仍然保留。', reconnect: true };
}

/** Business content is authoritative; observation only adds optional links and inspector views. */
export function createDataProjection() {
  const projectObservation = createObservationProjection();
  const projectReveal = createRevealProjection();
  let previous: ClientState | undefined;
  let previousOverview: ObserverOverview | undefined;
  let messages: readonly ConversationMessage[] = [];
  let previousContent: readonly ConversationMessage[] | undefined;
  let data: AppData = emptyAppData();
  return (state: ClientState): AppData => {
    const observation = projectObservation(state.observation, state.transcripts);
    const conversationChanged = previous?.messages !== state.messages || previousOverview !== observation.overview || previous?.transcriptId !== state.transcriptId;
    if (conversationChanged) messages = projectConversation(state.messages, observation.overview, state.transcriptId);
    const content = projectReveal(messages, state);
    const result = state.submission?.remote?.result;
    const admissionQueueChanged = result?.status === 'rejected' && result.retry === 'admission' && previous?.queue.waiting !== state.queue.waiting;
    const conversation = content !== previousContent || previous?.submissions !== state.submissions || previous?.submission !== state.submission || previous?.transcripts !== state.transcripts || previous?.queue.blocked !== state.queue.blocked || admissionQueueChanged ? projectResponses(content, state) : data.conversation;
    const current = observation.overview.executions.find((item) => item.calls.some((call) => call.recordType === 'execution' && call.contextId === state.contextId));
    const submission = projectSubmission(state);
    data = {
      config: state.config,
      busy: state.busy,
      queue: state.queue,
      runningId: current?.id ?? '',
      observationLoading: observation.loading,
      observationError: observation.error,
      conversationSync: projectConversationSync(state),
      conversation,
      messageCount: state.messages.length,
      submissionControl: submission.submissionControl,
      rounds: observation.rounds,
      memory: observation.memory,
      details: observation.details,
    };
    previous = state;
    previousOverview = observation.overview;
    previousContent = content;
    return data;
  };
}
