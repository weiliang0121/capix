import type { ClientState } from '@capix-observer/client-runtime';
import type { ObserverOverview } from '@capix-observer/protocol';
import { projectConversation } from '../observation/conversation.js';
import { emptyAppData } from '../state/data.js';
import type { AppData } from '../state/data.js';
import { createObservationProjection } from './observation.js';

/** Business content is authoritative; observation only adds optional links and inspector views. */
export function createDataProjection() {
  const projectObservation = createObservationProjection();
  let previous: ClientState | undefined;
  let previousOverview: ObserverOverview | undefined;
  let data: AppData = emptyAppData();
  return (state: ClientState): AppData => {
    const observation = projectObservation(state.observation);
    const conversationChanged = previous?.messages !== state.messages || previousOverview !== observation.overview;
    const current = observation.overview.executions.find((item) => item.calls.some((call) => call.recordType === 'execution' && call.contextId === state.contextId));
    data = {
      config: state.config,
      busy: state.busy,
      pending: state.pending,
      runningId: current?.id ?? '',
      observationLoading: observation.loading,
      observationError: observation.error,
      conversation: conversationChanged ? projectConversation(state.messages, observation.overview) : data.conversation,
      messageCount: state.messages.length,
      progress: state.busy ? (state.answered ? '回答已交付，正在完成后续处理…' : '正在处理…') : '',
      rounds: observation.rounds,
      memory: observation.memory,
      details: observation.details,
    };
    previous = state;
    previousOverview = observation.overview;
    return data;
  };
}
