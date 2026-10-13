import { observationStatus } from '../observation/status.js';
import type { ObservationState, TranscriptState } from '@capix/client-runtime';
import type { ObserverOverview, MemoryRecord } from '@capix/protocol';
import type { AppData, RoundView, MemoryView, ExecutionDetail } from '../state/data.js';
import type { CallGraphModel } from '../state/graph.js';
import { projectDetail } from './details.js';
import { errorMessage } from '../lib/errors.js';
import { updateOverviews } from './overview.js';
import { projectCallGraph } from './graph.js';

type ExecutionSummary = ObserverOverview['executions'][number];
interface GraphSource {
  calls: RoundView['calls'];
  detail: ExecutionDetail | undefined;
}
interface RoundProjection {
  dependencies: readonly unknown[];
  value: RoundView;
}
interface ExecutionProjection {
  source: ExecutionSummary;
  memories: readonly MemoryRecord[];
  answerIndex: number | undefined;
  value: ExecutionSummary;
}
const noMemoryRecords: readonly MemoryRecord[] = [];

function sameMembers(previous: readonly unknown[] | undefined, next: readonly unknown[]): boolean {
  return previous?.length === next.length && next.every((value, index) => previous[index] === value);
}

function projectRounds(overview: ObserverOverview, transcripts: ReadonlyMap<string, TranscriptState>, previous: ReadonlyMap<string, RoundProjection>, projectedCalls: WeakMap<object, RoundView['calls']>): Map<string, RoundProjection> {
  const counts = new Map(overview.messages.map((message) => [message.index, message.count]));
  return new Map(
    overview.executions.map((execution) => {
      const indexes = [...new Set(execution.selections.flatMap((selection) => selection.indexes ?? []))];
      const transcriptId = execution.transcriptRange?.transcriptId ?? overview.transcriptId;
      const snapshot = transcripts.get(transcriptId)?.snapshot;
      const messages = snapshot?.messages ?? [];
      const answer = execution.response?.index === undefined ? undefined : messages[execution.response.index];
      const dependencies = [execution, transcriptId, Boolean(snapshot), messages[execution.inputIndex], answer, counts.get(execution.inputIndex) ?? 0, ...indexes.flatMap((index) => [messages[index], counts.get(index) ?? 0])];
      const cached = previous.get(execution.id);
      if (sameMembers(cached?.dependencies, dependencies)) return [execution.id, cached!];
      if (execution.archive && !projectedCalls.has(execution.calls))
        projectedCalls.set(
          execution.calls,
          execution.calls.map((call) => ({ ...call, status: observationStatus(call.status, execution.archive) })),
        );
      const value: RoundView = {
        ...execution,
        status: observationStatus(execution.status, execution.archive),
        calls: execution.archive ? projectedCalls.get(execution.calls)! : execution.calls,
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
      return [execution.id, { dependencies, value }];
    }),
  );
}

/** Interpret records only for the optional observer. Never supplies conversation content. */
export function createObservationProjection() {
  let previous: ObservationState | undefined;
  let rawOverview: ObserverOverview = { transcriptId: '', messages: [], executions: [] };
  let overview = rawOverview;
  let previousTranscripts: ReadonlyMap<string, TranscriptState> | undefined;
  let rounds: readonly RoundView[] = [];
  let roundSources = new Map<string, RoundProjection>();
  let executionSources = new Map<string, ExecutionProjection>();
  let memoryRecords = new Map<string, readonly MemoryRecord[]>();
  let detailMemoryRecords = memoryRecords;
  let details: AppData['details'] = new Map();
  let graphs: AppData['graphs'] = new Map();
  let graphSources = new Map<string, GraphSource>();
  const projectedCalls = new WeakMap<object, RoundView['calls']>();
  let memory: MemoryView = { items: [] };
  return (state: ObservationState, transcripts: ReadonlyMap<string, TranscriptState>) => {
    const reset = !previous || previous.overview.executions !== state.overview.executions;
    const snapshots = reset ? [...state.updates.values()] : [...state.updates].filter(([id, snapshot]) => previous?.updates.get(id) !== snapshot).map(([, snapshot]) => snapshot);
    if (reset) rawOverview = state.overview;
    else if (previous?.overview.messages !== state.overview.messages) {
      // The source baseline owns pre-existing counts; new transcript locations extend this view.
      const counts = new Map(rawOverview.messages.map((message) => [message.index, message]));
      rawOverview = { ...rawOverview, messages: state.overview.messages.map((message) => counts.get(message.index) ?? message) };
    }
    if (snapshots.length) rawOverview = updateOverviews(rawOverview, snapshots);
    if (!previous || previous.memory !== state.memory) {
      const grouped = new Map<string, MemoryRecord[]>();
      for (const item of state.memory.items)
        for (const record of item.records) {
          if (!record.executionId) continue;
          const records = grouped.get(record.executionId) ?? [];
          records.push(record);
          grouped.set(record.executionId, records);
        }
      memoryRecords = new Map([...grouped].map(([id, records]) => [id, sameMembers(memoryRecords.get(id), records) ? memoryRecords.get(id)! : records]));
    }
    if (reset || snapshots.length || previous?.overview !== state.overview || previous?.memory !== state.memory || previous?.transcriptRecords !== state.transcriptRecords || previousTranscripts !== transcripts) {
      const answers = new Map<string, number>();
      for (const record of state.transcriptRecords ?? []) {
        if (!record.executionId || record.value.action !== 'append') continue;
        const messages = transcripts.get(record.transcriptId)?.snapshot?.messages;
        if (!messages) continue;
        const position = messages.slice(record.value.start, record.value.end).findIndex((message) => message.role === 'assistant');
        if (position >= 0) answers.set(record.executionId, record.value.start + position);
      }
      const nextSources = new Map<string, ExecutionProjection>();
      const executions = rawOverview.executions.map((execution) => {
        const records = memoryRecords.get(execution.id) ?? noMemoryRecords;
        const answerIndex = answers.get(execution.id) ?? execution.response?.index;
        const cached = executionSources.get(execution.id);
        if (cached?.source === execution && cached.memories === records && cached.answerIndex === answerIndex) {
          nextSources.set(execution.id, cached);
          return cached.value;
        }
        const memoryChanges = records.map((record) => ({ id: record.id, memoryId: record.memoryId, operationId: record.operationId, action: record.value.action, change: record.value.change }));
        const value = { ...execution, memoryChanges, ...(answerIndex !== undefined ? { response: { ...execution.response, index: answerIndex } } : {}) };
        nextSources.set(execution.id, { source: execution, memories: records, answerIndex, value });
        return value;
      });
      executionSources = nextSources;
      overview = { ...rawOverview, executions };
      roundSources = projectRounds(overview, transcripts, roundSources, projectedCalls);
      const nextRounds = [...roundSources.values()].map((source) => source.value);
      if (!sameMembers(rounds, nextRounds)) rounds = nextRounds;
    }
    if (!previous || previous.records !== state.records || previous.memory !== state.memory) {
      const next = new Map<string, ExecutionDetail>();
      for (const [id, snapshot] of state.records) {
        const records = memoryRecords.get(id) ?? noMemoryRecords;
        next.set(id, previous?.records.get(id) !== snapshot || (detailMemoryRecords.get(id) ?? noMemoryRecords) !== records ? projectDetail(snapshot, state.memory, records) : details.get(id)!);
      }
      details = next;
      detailMemoryRecords = memoryRecords;
    }
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
    if (!previous || previous.memory !== state.memory || previousTranscripts !== transcripts)
      memory = {
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
    previous = state;
    previousTranscripts = transcripts;
    const uncertain = overview.archives?.filter((archive) => archive.state !== 'sealed').length ?? 0;
    const notice = uncertain ? `${uncertain} 份历史记录来源未完整封存；保留最后已保存事实，不代表仍在执行。` : undefined;
    return { overview, rounds, details, graphs, memory, loading: state.loading, error: state.error, notice };
  };
}
