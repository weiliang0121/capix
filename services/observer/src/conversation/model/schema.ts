import { z } from 'zod';
import { nonBlankStringPattern, hasUniqueItems } from '@weiliang0121/capix-runtime';

/** Keep original text; the pattern also advertises the nonblank rule to the model. */
export const modelTextSchema = z.string().min(1).regex(nonBlankStringPattern, '文本不能只有空白字符。');

/** Refinement enforces uniqueness locally; metadata expresses the same rule in JSON Schema. */
export function modelIndexesSchema(minimum = 0) {
  return z.array(z.int().nonnegative()).min(minimum).refine(hasUniqueItems, '索引不能重复。').meta({ uniqueItems: true });
}
