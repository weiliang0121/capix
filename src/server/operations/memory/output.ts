import { RuntimeError } from '../../errors/error.js';
import { hasExactKeys, isObject } from '../../value/object.js';
import type { MemoryChange } from '../../memory/change.js';
import type { ModelOutputContract } from '../model.js';
import type { MemoryInput } from './input.js';

export interface MemoryExtraction {
  readonly memories: readonly MemoryChange[];
}
const indexesSchema = { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 0 } } as const;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;

export const memoryOutputContract = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['memories'],
    properties: {
      memories: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'memoryId', 'change', 'sourceIndexes', 'result'],
          properties: {
            action: { enum: ['create', 'update'] },
            memoryId: { type: ['string', 'null'] },
            change: { type: 'string', minLength: 1, maxLength: 1000 },
            sourceIndexes: indexesSchema,
            result: {
              type: 'object',
              additionalProperties: false,
              required: ['topic', 'content', 'sourceIndexes'],
              properties: {
                topic: { type: 'string', minLength: 1, maxLength: 120 },
                content: { type: 'string', minLength: 1, maxLength: 2000 },
                sourceIndexes: indexesSchema,
              },
            },
          },
          allOf: [
            { if: { properties: { action: { const: 'create' } } }, then: { properties: { memoryId: { type: 'null' } } } },
            { if: { properties: { action: { const: 'update' } } }, then: { properties: { memoryId: { type: 'string', minLength: 1 } } } },
          ],
        },
      },
    },
  },
  accept(value: unknown, input: MemoryInput): MemoryExtraction {
    if (!isObject(value) || !hasExactKeys(value, ['memories']) || !Array.isArray(value.memories) || value.memories.length > 4) throw new RuntimeError('OUTPUT_SHAPE', '记忆提取必须返回 memories 数组，最多四项变更。');
    const candidates = value.memories.map((item) => acceptCandidate(item, input));
    const targets = candidates.filter((item) => item.action === 'update').map((item) => item.memoryId);
    if (new Set(targets).size !== targets.length) throw new RuntimeError('MEMORY_TARGET', '同批不能重复更新一个记忆体。');
    const memories = candidates.filter((item) => !isUnchanged(item, input));
    for (const item of memories) requireCurrentEvidence(item, input);
    return { memories };
  },
} as const satisfies ModelOutputContract<MemoryInput, MemoryExtraction>;

function acceptIndexes(value: unknown, input: MemoryInput, inherited: readonly number[] = []): number[] {
  if (!Array.isArray(value) || !value.length || !value.every((index) => Number.isSafeInteger(index)) || new Set(value).size !== value.length) throw new RuntimeError('OUTPUT_SHAPE', '来源索引必须非空且不重复。');
  const available = new Set([...input.messages.map((item) => item.index), ...inherited]);
  if (value.some((index) => !available.has(index))) throw new RuntimeError('MEMORY_SOURCE', '来源必须属于可见原文或目标记忆已有的依据。');
  return [...value];
}

function acceptCandidate(value: unknown, input: MemoryInput): MemoryChange {
  if (!isObject(value) || !hasExactKeys(value, ['action', 'memoryId', 'change', 'sourceIndexes', 'result']) || !text(value.change, 1000)) throw new RuntimeError('OUTPUT_SHAPE', '记忆变更需要 action、memoryId、change、sourceIndexes 和 result。');
  if (value.action !== 'create' && value.action !== 'update') throw new RuntimeError('OUTPUT_SHAPE', '记忆动作只能为 create 或 update。');
  if ((value.action === 'create' && value.memoryId !== null) || (value.action === 'update' && (typeof value.memoryId !== 'string' || !input.memories.some((memory) => memory.id === value.memoryId)))) throw new RuntimeError('MEMORY_TARGET', '创建不指定 ID，更新必须指向本次可见的已有记忆体。');
  const result = value.result;
  if (!isObject(result) || !hasExactKeys(result, ['topic', 'content', 'sourceIndexes']) || !text(result.topic, 120) || !text(result.content, 2000)) throw new RuntimeError('OUTPUT_SHAPE', 'result 必须包含完整 topic、content、sourceIndexes。');
  const sourceIndexes = acceptIndexes(value.sourceIndexes, input);
  const previous = value.action === 'update' ? input.memories.find((memory) => memory.id === value.memoryId) : undefined;
  const resultIndexes = acceptIndexes(result.sourceIndexes, input, previous?.sourceIndexes);
  if (!sourceIndexes.every((index) => resultIndexes.includes(index))) throw new RuntimeError('MEMORY_SOURCE', '变更后的依据必须包含本次变更依据。');
  return { action: value.action, memoryId: value.memoryId, change: value.change, sourceIndexes, result: { topic: result.topic, content: result.content, sourceIndexes: resultIndexes } } as MemoryChange;
}

/** Only exact content equality is a no-op; the model's change description is not evidence of equality. */
function isUnchanged(change: MemoryChange, input: MemoryInput): boolean {
  if (change.action !== 'update') return false;
  const previous = input.memories.find((memory) => memory.id === change.memoryId)!;
  const result = change.result;
  return previous.topic === result.topic && previous.content === result.content && previous.sourceIndexes.length === result.sourceIndexes.length && previous.sourceIndexes.every((index, position) => index === result.sourceIndexes[position]);
}

function requireCurrentEvidence(change: MemoryChange, input: MemoryInput): void {
  if (!change.sourceIndexes.some((index) => input.currentIndexes.includes(index))) throw new RuntimeError('MEMORY_SOURCE', '本次变化必须包含本轮依据。');
}
