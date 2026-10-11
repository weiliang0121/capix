import type { ClientState } from '@capix/client-runtime';
import type { ObserverOverview } from '@capix/protocol';
import { projectConversation } from '../observation/conversation.js';
import { emptyAppData } from '../state/data.js';
import type { AppData } from '../state/data.js';
import { errorMessage } from '../lib/errors.js';
import { createObservationProjection } from './observation.js';
import { projectSubmission } from './submission.js';
import { projectConversationActivities } from './activities.js';
import type { ConversationMessage } from '../state/conversation.js';

/** Business content is authoritative; observation only adds optional links and inspector views. */
export function createDataProjection() {
  const projectObservation = createObservationProjection();
  let previous: ClientState | undefined;
  let previousOverview: ObserverOverview | undefined;
  let messages: readonly ConversationMessage[] = [];
  let data: AppData = emptyAppData();
  return (state: ClientState): AppData => {
    const observation = projectObservation(state.observation, state.transcripts);
    const conversationChanged = previous?.messages !== state.messages || previousOverview !== observation.overview || previous?.transcriptId !== state.transcriptId;
    if (conversationChanged) messages = projectConversation(state.messages, observation.overview, state.transcriptId);
    const activities = conversationChanged || previous?.submissions !== state.submissions || previous?.submission?.id !== state.submission?.id ? projectConversationActivities(messages, state) : { conversation: data.conversation, pendingProcesses: data.pendingProcesses };
    const transcriptError = state.transcriptId ? state.transcripts.get(state.transcriptId)?.error : undefined;
    const current = observation.overview.executions.find((item) => item.calls.some((call) => call.recordType === 'execution' && call.contextId === state.contextId));
    const submission = projectSubmission(state);
    const currentProcess = state.submission && (activities.pendingProcesses.some((process) => process.id === state.submission!.id) || activities.conversation.some((row) => row.processes?.some((process) => process.id === state.submission!.id)));
    data = {
      config: state.config,
      busy: state.busy,
      queue: state.queue,
      pending: state.pending,
      pendingLabel: state.submission?.feedback.status === 'interrupted' || state.submission?.feedback.status === 'ended' ? '提交待确认' : '等待接纳',
      runningId: current?.id ?? '',
      observationLoading: observation.loading,
      observationError: observation.error,
      conversationError: transcriptError ? errorMessage(transcriptError) : undefined,
      ...activities,
      messageCount: state.messages.length,
      ...submission,
      // A current activity replaces the generic waiting hint. Body synchronization after
      // completion remains a separate, useful status until the answer is available.
      progress: currentProcess && !state.submission?.remote?.result ? '' : submission.progress,
      rounds: observation.rounds,
      memory: observation.memory,
      details: observation.details,
    };
    previous = state;
    previousOverview = observation.overview;
    return data;
  };
}
