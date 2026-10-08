import { z } from 'zod';
import type { Selection } from '../../model/types.js';
import { RuntimeError } from '@capix-observer/runtime';

import { modelIndexesSchema } from '../../model/schema.js';
import type { ModelOutputContract } from '../../model/contract.js';

export interface SelectionBasis {
  readonly start: number;
  readonly end: number;
}

const selectionSchema = z.strictObject({ historyIndexes: modelIndexesSchema() }) satisfies z.ZodType<Selection>;

/** Static structure is checked before references against this execution's history. */
export const selectionOutputContract = {
  schema: z.toJSONSchema(selectionSchema),
  accept(value: unknown, basis: SelectionBasis): Selection {
    const parsed = selectionSchema.safeParse(value);
    if (!parsed.success) throw new RuntimeError('OUTPUT_SHAPE', '选择结果必须是仅含 historyIndexes 的对象，索引为不重复的非负整数。', { issues: parsed.error.issues });
    checkHistoryReferences(parsed.data, basis.start, basis.end);
    return parsed.data;
  },
} as const satisfies ModelOutputContract<SelectionBasis, Selection>;

function checkHistoryReferences(value: Selection, start: number, end: number): void {
  const invalid = value.historyIndexes.filter((index) => index < start || index >= end);
  const count = end - start;
  if (invalid.length) throw new RuntimeError('INDEX_OUT_OF_RANGE', `索引不存在：${invalid.join(', ')}；历史条目数为 ${count}。`, { invalid, count });
}
