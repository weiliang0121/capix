import { observationStatus } from '../observation/status.js';
import type { RelationChangeRecord } from '@capix/protocol';
import { isPlainObject, isString } from 'es-toolkit/predicate';
import type { CallDetail, ExecutionDetail, RoundView } from '../state/data.js';
import type { CallGraphModel, CallGraphNode } from '../state/graph.js';

interface GraphEntry {
  readonly node: Omit<CallGraphNode, 'children' | 'order'>;
  readonly parentId?: string;
  readonly attachedAt?: number;
}

const capabilityLabels: Readonly<Record<string, string>> = { checkFile: '预检文件任务', answer: '生成回答', document: '读取并处理文档', save: '保存结果文件' };

function object(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function short(value: string): string {
  return value.length > 120 ? `${value.slice(0, 119)}…` : value;
}

function pathSummary(value: unknown): string | undefined {
  const task = object(value);
  const destination = object(task.output);
  const parts = [isString(task.sourcePath) ? `来源 ${task.sourcePath}` : undefined, isString(destination.path) ? `目标 ${destination.path}` : undefined].filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

/** These are interpretations of known Observer contracts, never inferred model reasoning. */
function summarize(call: CallDetail, accepted: unknown): string | undefined {
  const output = object(call.output);
  const name = call.recordType === 'attempt' ? call.operation?.split('.').at(-1) : call.operation;
  if (name === 'conversationDecision') {
    const received = object(accepted);
    if (received.kind === 'revise') {
      const feedback = object(received.feedback);
      return `父层要求修正${isString(feedback.message) ? `：${feedback.message}` : ''}`;
    }
    if (output.kind === 'invoke' && isString(output.capability)) return `提议：${capabilityLabels[output.capability] ?? output.capability}`;
    if (output.kind === 'finish') {
      const conclusion = object(output.conclusion);
      if (conclusion.kind === 'settled') return '提议结束本轮';
      if (conclusion.kind === 'clarify' && isString(conclusion.question)) return `提议补充：${conclusion.question}`;
      if (conclusion.kind === 'unsupported' && isString(conclusion.explanation)) return `提议说明不支持：${conclusion.explanation}`;
    }
  }
  if (name === 'checkFileTask' || name === 'inspectFileTask') {
    if (output.kind === 'ready') return `预检通过${pathSummary(output.task) ? ` · ${pathSummary(output.task)}` : ''}`;
    if (output.kind === 'revise' && isString(output.feedback)) return `候选需修正：${output.feedback}`;
    if (output.kind === 'needs-input' && isString(output.question)) return `待补充：${output.question}`;
  }
  if (name === 'understanding') {
    if (output.kind === 'reply') return '候选：直接回答';
    if (output.kind === 'file') return `文件候选${pathSummary(output.task) ? ` · ${pathSummary(output.task)}` : ''}`;
    if (output.kind === 'clarify' && isString(output.question)) return `澄清候选：${output.question}`;
    if (output.kind === 'unsupported' && isString(output.explanation)) return `不支持候选：${output.explanation}`;
  }
  if ((name === 'saveResult' || name === 'createText' || name === 'readText') && isString(output.path) && Number.isSafeInteger(output.bytes) && isString(output.digest)) return `${name === 'readText' ? '已读取' : '已创建'} ${output.path} · ${output.bytes} 字节`;
  if (name === 'selection' && Array.isArray(output.historyIndexes) && output.historyIndexes.every(Number.isSafeInteger)) return `选中 ${output.historyIndexes.length} 条历史`;
  if (name === 'prepareContext') {
    const selection = object(output.selection);
    if (Array.isArray(selection.historyIndexes) && selection.historyIndexes.every(Number.isSafeInteger)) return `已准备 ${selection.historyIndexes.length} 条历史`;
  }
  if (name === 'maintainContext' && Array.isArray(output.messageIndexes) && Array.isArray(output.memories)) return `活跃材料：${output.messageIndexes.length} 条消息 · ${output.memories.length} 个记忆`;
  if ((name === 'answer' || name === 'processDocument') && isString(output.content)) {
    if (output.kind === 'answer') return `已生成 ${output.content.length} 字符`;
    if (output.kind === 'needs-info') return '返回补充信息请求';
    if (output.kind === 'unknown') return '返回无法回答的说明';
  }
  if (name === 'memory' && call.status === 'passed') return call.memory.changes.length ? `记忆变化 ${call.memory.changes.length} 项` : '未记录记忆变化';
  return;
}

function reception(entry: RelationChangeRecord): NonNullable<CallGraphNode['reception']> {
  const change = entry.change;
  if (change.kind === 'attached') return { status: change.kind, label: '等待返回' };
  if (change.kind === 'returned') return { status: change.kind, label: change.result.status === 'failed' ? '子调用返回失败' : '已返回，待父层接纳' };
  if (change.kind === 'receiving') return { status: change.kind, label: '父层接纳中' };
  if (change.kind === 'failed') return { status: change.kind, label: change.source === 'observation' ? '接纳观测失败' : '父层接纳失败' };
  return { status: change.kind, label: '父层已接纳' };
}

/** Geometry-free application projection. Time is a property, never a relation or ordering source. */
export function projectCallGraph(round: RoundView, detail?: ExecutionDetail): CallGraphModel {
  const entries = new Map<string, GraphEntry>();
  const calls = new Map(round.calls.map((call) => [call.id, call]));
  const matchingDetail = detail?.id === round.id ? detail : undefined;
  const root = matchingDetail?.calls.get(round.id);
  const runtimeId = root?.parentId && matchingDetail?.calls.get(root.parentId)?.recordType === 'runtime' ? root.parentId : undefined;
  let incomplete = false;
  const identities = new Set([...calls.keys(), ...[...(matchingDetail?.calls.values() ?? [])].filter((call) => call.recordType !== 'runtime').map((call) => call.id)]);
  for (const id of identities) {
    const summary = calls.get(id);
    const local = matchingDetail?.calls.get(id);
    const call = local ?? summary!;
    if (call.recordType === 'runtime') continue;
    const parent = call.parentId ? matchingDetail?.calls.get(call.parentId) : undefined;
    const relations = parent?.relationEntries.filter((entry) => entry.childId === id || entry.identity.childContextId === call.contextId) ?? [];
    const attached = relations.find((entry) => entry.change.kind === 'attached');
    const latest = relations.reduce<RelationChangeRecord | undefined>((previous, entry) => (!previous || entry.eventSequence > previous.eventSequence ? entry : previous), undefined);
    const accepted = latest?.change.kind === 'accepted' ? latest.change.output : undefined;
    const description = local ? summarize(local, accepted) : undefined;
    const missingRelation = Boolean(matchingDetail && id !== round.id && (!parent || !attached));
    if (missingRelation) incomplete = true;
    entries.set(id, {
      parentId: call.parentId,
      ...(attached ? { attachedAt: attached.eventSequence } : {}),
      node: {
        id,
        label: call.label,
        level: call.recordType,
        status: call.status === 'unresolved' ? 'unresolved' : observationStatus(call.status === 'passed' ? 'succeeded' : call.status, round.archive),
        name: local?.operation ?? summary?.name,
        ...(call.durationMs === undefined ? {} : { durationMs: call.durationMs }),
        ...(description ? { summary: short(description) } : {}),
        ...(latest ? { reception: reception(latest) } : {}),
        ...(missingRelation ? { incomplete: true } : {}),
      },
    });
  }
  const descendants = new Map<string, GraphEntry[]>();
  const detached: GraphEntry[] = [];
  for (const [id, entry] of entries) {
    if (id === round.id) continue;
    if (!entry.parentId || !entries.has(entry.parentId)) {
      detached.push(entry);
      incomplete = true;
    } else {
      const children = descendants.get(entry.parentId) ?? [];
      children.push(entry);
      descendants.set(entry.parentId, children);
    }
  }
  const visited = new Set<string>();
  const build = (entry: GraphEntry, order?: number): CallGraphNode => {
    visited.add(entry.node.id);
    const children = descendants.get(entry.node.id) ?? [];
    const ordered = children.length > 0 && children.every((child) => child.attachedAt !== undefined);
    const sequence = ordered ? [...children].sort((a, b) => a.attachedAt! - b.attachedAt!) : children;
    const projected: CallGraphNode[] = [];
    let invalid = false;
    for (const [index, child] of sequence.entries()) {
      if (visited.has(child.node.id)) {
        incomplete = true;
        invalid = true;
      } else projected.push(build(child, ordered ? index + 1 : undefined));
    }
    return { ...entry.node, ...(order === undefined ? {} : { order }), ...(invalid ? { incomplete: true } : {}), children: projected };
  };
  const execution = entries.get(round.id);
  const roots = execution?.node.level === 'execution' ? [build(execution)] : [];
  if (!roots.length) incomplete = true;
  const unattached = detached.filter((entry) => !visited.has(entry.node.id)).map((entry) => ({ ...build(entry), incomplete: true }));
  // Preserve unreachable cycles as incomplete calls, without inventing a link to E.
  for (const entry of entries.values()) {
    if (!visited.has(entry.node.id)) {
      incomplete = true;
      unattached.push({ ...build(entry), incomplete: true });
    }
  }
  return { roots, detached: unattached, summaryOnly: !matchingDetail, ...(runtimeId ? { runtimeId } : {}), incomplete };
}
