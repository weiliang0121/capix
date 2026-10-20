import { pick } from 'es-toolkit/object';
import { isEqual } from 'es-toolkit/predicate';
import { z } from 'zod';
import { RuntimeError, hasUniqueItems } from '@capix/server-runtime';
import { type MemoryChange } from '@capix/server-runtime/content';
import type { MemoryResultSource } from '@capix/protocol';

import type { ModelOutputContract } from '../../model/contract.js';
import type { MemoryInput } from './input.js';
import { modelIndexesSchema, modelTextSchema } from '../../model/schema.js';

const indexesSchema = modelIndexesSchema(1);
const resultIdsSchema = z.array(z.string().min(1)).refine(hasUniqueItems, '操作结果来源不能重复。').meta({ uniqueItems: true }).optional();
const resultSchema = z.strictObject({
  topic: modelTextSchema.max(120),
  content: modelTextSchema.max(2000),
  sourceIndexes: indexesSchema,
  sourceResultIds: resultIdsSchema,
});
const changeShape = {
  change: modelTextSchema.max(1000),
  sourceIndexes: indexesSchema,
  sourceResultIds: resultIdsSchema,
  result: resultSchema,
};
const changeSchema = z.discriminatedUnion('action', [z.strictObject({ action: z.literal('create'), memoryId: z.null(), ...changeShape }), z.strictObject({ action: z.literal('update'), memoryId: z.string().min(1), ...changeShape })]);
const extractionSchema = z.strictObject({ memories: z.array(changeSchema).max(4) });

type MemoryProposal = z.infer<typeof changeSchema>;
export interface MemoryExtraction {
  readonly memories: readonly MemoryChange[];
}

export const memoryOutputContract = {
  schema: z.toJSONSchema(extractionSchema),
  accept(value: unknown, input: MemoryInput): MemoryExtraction {
    const parsed = extractionSchema.safeParse(value);
    if (!parsed.success) throw new RuntimeError('OUTPUT_SHAPE', '记忆提取结果不符合变更结构。', { issues: parsed.error.issues });
    const candidates = parsed.data.memories;
    const accepted = candidates.map((item) => acceptCandidate(item, input));
    const targets = candidates.filter((item) => item.action === 'update').map((item) => item.memoryId);
    if (!hasUniqueItems(targets)) throw new RuntimeError('MEMORY_TARGET', '同批不能重复更新一个记忆体。');
    const memories = accepted.filter((item) => !isUnchanged(item, input));
    for (const item of memories) requireCurrentEvidence(item, input);
    return { memories };
  },
} as const satisfies ModelOutputContract<MemoryInput, MemoryExtraction>;

function checkIndexes(indexes: readonly number[], input: MemoryInput, inherited: readonly number[] = []): void {
  const available = new Set([...input.messages.map((item) => item.index), ...inherited]);
  if (indexes.some((index) => !available.has(index))) throw new RuntimeError('MEMORY_SOURCE', '来源必须属于可见原文或目标记忆已有的依据。');
}

function acceptCandidate(change: MemoryProposal, input: MemoryInput): MemoryChange {
  const previous = change.action === 'update' ? input.memories.find((memory) => memory.id === change.memoryId) : undefined;
  if (change.action === 'update' && !previous) throw new RuntimeError('MEMORY_TARGET', '更新必须指向本次可见的已有记忆体。');
  checkIndexes(change.sourceIndexes, input);
  checkIndexes(change.result.sourceIndexes, input, previous?.sourceIndexes);
  if (!change.sourceIndexes.every((index) => change.result.sourceIndexes.includes(index))) throw new RuntimeError('MEMORY_SOURCE', '变更后的依据必须包含本次变更依据。');
  if (change.sourceResultIds?.some((id) => !change.result.sourceResultIds?.includes(id))) throw new RuntimeError('MEMORY_SOURCE', '变更后的操作来源必须包含本次变更操作来源。');
  const sourceResults = resolveResults(change.sourceResultIds, input.results ?? []);
  const resultSources = resolveResults(change.result.sourceResultIds, [...(input.results ?? []), ...(previous?.sourceResults ?? [])]);
  const { sourceResultIds: _changeIds, result, ...accepted } = change;
  const { sourceResultIds: _resultIds, ...content } = result;
  return { ...accepted, ...(sourceResults ? { sourceResults } : {}), result: { ...content, ...(resultSources ? { sourceResults: resultSources } : {}) } };
}

function resolveResults(ids: readonly string[] | undefined, available: readonly MemoryResultSource[]): readonly MemoryResultSource[] | undefined {
  if (!ids?.length) return undefined;
  return Object.freeze(
    ids.map((id) => {
      const source = available.find((item) => item.id === id);
      if (!source) throw new RuntimeError('MEMORY_SOURCE', '操作来源必须属于本轮已接纳结果或目标记忆已有的依据。');
      return Object.freeze({ ...source, receipt: Object.freeze({ ...source.receipt }) });
    }),
  );
}

/** Only exact content equality is a no-op; the model's change description is not evidence of equality. */
function isUnchanged(change: MemoryChange, input: MemoryInput): boolean {
  if (change.action !== 'update') return false;
  const previous = input.memories.find((memory) => memory.id === change.memoryId)!;
  return isEqual(pick(previous, ['topic', 'content', 'sourceIndexes', 'sourceResults']), change.result);
}

function requireCurrentEvidence(change: MemoryChange, input: MemoryInput): void {
  if (!change.sourceIndexes.some((index) => input.currentIndexes.includes(index))) throw new RuntimeError('MEMORY_SOURCE', '本次变化必须包含本轮依据。');
}
