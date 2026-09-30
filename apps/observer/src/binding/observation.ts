import type { ObservationState } from '@capix-observer/client-runtime';
import type { ObserverOverview } from '@capix-observer/protocol';
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

/** Interpret records only for the optional observer. Never supplies conversation content. */
export function createObservationProjection() {
  let previous: ObservationState | undefined;
  let overview: ObserverOverview = { messages: [], executions: [] };
  let rounds: readonly RoundView[] = [];
  let details: AppData['details'] = new Map();
  return (state: ObservationState) => {
    if (!previous || previous.overview !== state.overview || previous.updates !== state.updates || previous.memory !== state.memory || previous.transcriptRecords !== state.transcriptRecords) {
      overview = [...state.updates.values()].reduce(updateOverview, state.overview);
      overview = {
        ...overview,
        executions: overview.executions.map((execution) => {
          const answer = [...(state.transcriptRecords ?? [])].reverse().find((record) => record.executionId === execution.id && record.value.action === 'append' && record.value.messages.some((message) => message.role === 'assistant'));
          const answerIndex = answer?.value.action === 'append' ? answer.value.start + answer.value.messages.findIndex((message) => message.role === 'assistant') : execution.response?.index;
          const memoryChanges = state.memory.items
            .flatMap((item) => item.records)
            .filter((record) => record.executionId === execution.id)
            .map((record) => ({ id: record.id, memoryId: record.memoryId, operationId: record.operationId, action: record.value.action, change: record.value.change }));
          return { ...execution, memoryChanges, ...(execution.response && answerIndex !== undefined ? { response: { ...execution.response, index: answerIndex } } : {}) };
        }),
      };
      rounds = projectRounds(overview);
    }
    if (!previous || previous.records !== state.records || previous.memory !== state.memory) {
      const next = new Map(details);
      for (const [id, snapshot] of state.records) {
        if (previous?.records.get(id) !== snapshot || previous?.memory !== state.memory) next.set(id, projectDetail(snapshot, state.memory));
      }
      details = next;
    }
    previous = state;
    return { overview, rounds, details, memory: state.memory, loading: state.loading, error: state.error };
  };
}
