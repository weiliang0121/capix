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
    if (!previous || previous.overview !== state.overview || previous.updates !== state.updates) {
      overview = [...state.updates.values()].reduce(updateOverview, state.overview);
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
