import type { ClientState } from '@capix-observer/client-runtime';
import type { ObserverOverview } from '@capix-observer/protocol';
import { projectConversation } from '../observation/conversation.js';
import { emptyAppData } from '../state/data.js';
import type { AppData, RoundView } from '../state/data.js';
import { projectDetail } from './details.js';
import { updateOverview } from './overview.js';

function projectRounds(overview: ObserverOverview): RoundView[] {
  const messages = new Map(overview.messages.map((message) => [message.index, message]));
  return overview.executions.map((execution) => {
    const indexes = [...new Set(execution.selections.flatMap((selection) => selection.indexes ?? []))];
    return {
      ...execution,
      inputContent: messages.get(execution.inputIndex)?.message.content ?? '输入记录不可用',
      context: {
        inputCount: messages.get(execution.inputIndex)?.count ?? 0,
        selectedCount: indexes.length,
        selectionComplete: execution.selections.some((selection) => selection.status === 'succeeded'),
        selectedMessages: indexes.map((index) => ({ index, entry: messages.get(index) })),
      },
    };
  });
}

/** One binding owns its projection cache. Components never interpret runtime snapshots. */
export function createDataProjection() {
  let previous: ClientState | undefined;
  let data: AppData = emptyAppData();
  let overview: ObserverOverview = { messages: [], executions: [] };
  return (state: ClientState): AppData => {
    const overviewChanged = !previous || previous.overview !== state.overview || previous.updates !== state.updates;
    if (overviewChanged) overview = [...state.updates.values()].reduce(updateOverview, state.overview);
    const conversationChanged = overviewChanged || previous?.messages !== state.messages;
    const details = new Map(data.details);
    for (const [id, snapshot] of state.records) {
      if (previous?.records.get(id) !== snapshot || previous?.memory !== state.memory) details.set(id, projectDetail(snapshot, state.memory));
    }
    const current = overview.executions.find((item) => item.id === state.runningId);
    data = {
      config: state.config,
      busy: state.busy,
      pending: state.pending,
      runningId: state.runningId,
      conversation: conversationChanged ? projectConversation(state.messages, overview) : data.conversation,
      messageCount: state.messages.length,
      progress: state.busy ? (current?.memoryStatus === 'running' ? '正在整理本轮记忆…' : '正在运行，记录持续更新…') : '',
      rounds: overviewChanged ? projectRounds(overview) : data.rounds,
      memory: state.memory,
      details: previous?.records === state.records && previous?.memory === state.memory ? data.details : details,
    };
    previous = state;
    return data;
  };
}
