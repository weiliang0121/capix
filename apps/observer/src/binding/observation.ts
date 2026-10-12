import { observationStatus } from '../observation/status.js';
import type { ObservationState, TranscriptState } from '@capix/client-runtime';
import type { ObserverOverview } from '@capix/protocol';
import type { AppData, RoundView, MemoryView, ExecutionDetail } from '../state/data.js';
import type { CallGraphModel } from '../state/graph.js';
import { projectDetail } from './details.js';
import { errorMessage } from '../lib/errors.js';
import { updateOverview } from './overview.js';
import { projectCallGraph } from './graph.js';

interface GraphSource {
  calls: RoundView['calls'];
  detail: ExecutionDetail | undefined;
}

function projectRounds(overview: ObserverOverview, transcripts: ReadonlyMap<string, TranscriptState>, projectedCalls: WeakMap<object, RoundView['calls']>): RoundView[] {
  const counts = new Map(overview.messages.map((message) => [message.index, message.count]));
  return overview.executions.map((execution) => {
    const indexes = [...new Set(execution.selections.flatMap((selection) => selection.indexes ?? []))];
    const transcriptId = execution.transcriptRange?.transcriptId ?? overview.transcriptId;
    const snapshot = transcripts.get(transcriptId)?.snapshot;
    const messages = snapshot?.messages ?? [];
    const answer = execution.response?.index === undefined ? undefined : messages[execution.response.index];
    const calls = execution.calls;
    const previousCalls = projectedCalls.get(execution.calls);
    if (execution.archive && !previousCalls)
      projectedCalls.set(
        execution.calls,
        execution.calls.map((call) => ({ ...call, status: observationStatus(call.status, execution.archive) })),
      );
    return {
      ...execution,
      status: observationStatus(execution.status, execution.archive),
      calls: execution.archive ? projectedCalls.get(execution.calls)! : calls,
      transcriptId,
      messagesLoaded: Boolean(snapshot),
      ...(execution.response ? { response: { ...execution.response, ...(answer ? { content: answer.content } : {}) } } : {}),
      inputContent: messages[execution.inputIndex]?.content ?? (snapshot ? '输入消息不可用' : '消息尚未加载'),
      context: {
        inputCount: counts.get(execution.inputIndex) ?? 0,
        selectedCount: indexes.length,
        selectionComplete: execution.selections.some((selection) => selection.status === 'succeeded'),
        selectedMessages: indexes.map((index) => ({ index, entry: messages[index] ? { index, count: counts.get(index) ?? 0, message: messages[index] } : undefined })),
      },
    };
  });
}

/** Interpret records only for the optional observer. Never supplies conversation content. */
export function createObservationProjection() {
  let previous: ObservationState | undefined;
  let overview: ObserverOverview = { transcriptId: '', messages: [], executions: [] };
  let previousTranscripts: ReadonlyMap<string, TranscriptState> | undefined;
  let rounds: readonly RoundView[] = [];
  let details: AppData['details'] = new Map();
  let graphs: AppData['graphs'] = new Map();
  let graphSources = new Map<string, GraphSource>();
  const projectedCalls = new WeakMap<object, RoundView['calls']>();
  return (state: ObservationState, transcripts: ReadonlyMap<string, TranscriptState>) => {
    if (!previous || previous.overview !== state.overview || previous.updates !== state.updates || previous.memory !== state.memory || previous.transcriptRecords !== state.transcriptRecords || previousTranscripts !== transcripts) {
      overview = [...state.updates.values()].reduce(updateOverview, state.overview);
      overview = {
        ...overview,
        executions: overview.executions.map((execution) => {
          const answer = [...(state.transcriptRecords ?? [])].reverse().find(
            (record) =>
              record.executionId === execution.id &&
              record.value.action === 'append' &&
              transcripts
                .get(record.transcriptId)
                ?.snapshot?.messages.slice(record.value.start, record.value.end)
                .some((message) => message.role === 'assistant'),
          );
          const answerMessages = answer ? transcripts.get(answer.transcriptId)?.snapshot?.messages : undefined;
          const answerIndex = answer?.value.action === 'append' && answerMessages ? answer.value.start + answerMessages.slice(answer.value.start, answer.value.end).findIndex((message) => message.role === 'assistant') : execution.response?.index;
          const memoryChanges = state.memory.items
            .flatMap((item) => item.records)
            .filter((record) => record.executionId === execution.id)
            .map((record) => ({ id: record.id, memoryId: record.memoryId, operationId: record.operationId, action: record.value.action, change: record.value.change }));
          return { ...execution, memoryChanges, ...(answerIndex !== undefined ? { response: { ...execution.response, index: answerIndex } } : {}) };
        }),
      };
      rounds = projectRounds(overview, transcripts, projectedCalls);
    }
    if (!previous || previous.records !== state.records || previous.memory !== state.memory) {
      const next = new Map<string, ExecutionDetail>();
      for (const [id, snapshot] of state.records) {
        next.set(id, previous?.records.get(id) !== snapshot || previous?.memory !== state.memory ? projectDetail(snapshot, state.memory) : details.get(id)!);
      }
      details = next;
    }
    previous = state;
    previousTranscripts = transcripts;
    let nextGraphs: Map<string, CallGraphModel> | undefined;
    const nextSources = new Map<string, GraphSource>();
    for (const round of rounds) {
      const detail = details.get(round.id);
      const source = graphSources.get(round.id);
      if (!source || source.calls !== round.calls || source.detail !== detail) {
        nextGraphs ??= new Map(graphs);
        nextGraphs.set(round.id, projectCallGraph(round, detail));
      }
      nextSources.set(round.id, { calls: round.calls, detail });
    }
    for (const id of graphs.keys()) {
      if (!nextSources.has(id)) {
        nextGraphs ??= new Map(graphs);
        nextGraphs.delete(id);
      }
    }
    graphSources = nextSources;
    if (nextGraphs) graphs = nextGraphs;
    const memory: MemoryView = {
      items: state.memory.items.map((item) => ({
        ...item,
        sources: item.sources.map((source) => {
          const entity = transcripts.get(source.transcriptId);
          const message = entity?.snapshot?.messages[source.index];
          const loading = entity?.sync.status === 'connecting' || entity?.sync.status === 'retrying';
          const failure = entity?.sync.status === 'failed' ? entity.sync : undefined;
          return { ...source, ...(message ? { message } : {}), state: message ? 'loaded' : loading ? 'loading' : failure ? 'error' : entity?.snapshot ? 'missing' : 'unloaded', ...(failure ? { error: errorMessage(failure.error) } : {}) };
        }),
      })),
    };
    const uncertain = overview.archives?.filter((archive) => archive.state !== 'sealed').length ?? 0;
    const notice = uncertain ? `${uncertain} 份历史记录来源未完整封存；保留最后已保存事实，不代表仍在执行。` : undefined;
    return { overview, rounds, details, graphs, memory, loading: state.loading, error: state.error, notice };
  };
}
