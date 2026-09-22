import type { Selection } from '../../../shared/types.js';
import type { SelectionInput } from './input.js';
import { RuntimeError } from '../../errors/error.js';
import { hasExactKeys, isObject } from '../../value/object.js';
import type { ModelOutputContract } from '../model.js';

/** The advertised shape and its local acceptance rules belong to the same operation. */
export const selectionOutputContract = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['historyIndexes'],
    properties: {
      historyIndexes: { type: 'array', uniqueItems: true, items: { type: 'integer', minimum: 0 } },
    },
  },
  accept(value: unknown, input: SelectionInput): Selection {
    checkSelection(value);
    checkHistoryReferences(value, input.historyRange.start, input.historyRange.end);
    return orderSelection(value);
  },
} as const satisfies ModelOutputContract<SelectionInput, Selection>;

function checkSelection(value: unknown): asserts value is Selection {
  // Local acceptance also requires safe integers; bounds depend on this invocation's history.
  if (!isObject(value) || !hasExactKeys(value, ['historyIndexes']) || !Array.isArray(value.historyIndexes) || !value.historyIndexes.every((n) => Number.isSafeInteger(n) && n >= 0) || new Set(value.historyIndexes).size !== value.historyIndexes.length) {
    throw new RuntimeError('OUTPUT_SHAPE', '选择结果必须是仅含 historyIndexes 的对象，索引为不重复的非负整数。');
  }
}

function checkHistoryReferences(value: Selection, start: number, end: number): void {
  const invalid = value.historyIndexes.filter((index) => index < start || index >= end);
  const count = end - start;
  if (invalid.length) throw new RuntimeError('INDEX_OUT_OF_RANGE', `索引不存在：${invalid.join(', ')}；历史条目数为 ${count}。`, { invalid, count });
}

function orderSelection(value: Selection): Selection {
  return { historyIndexes: [...value.historyIndexes].sort((a, b) => a - b) };
}
