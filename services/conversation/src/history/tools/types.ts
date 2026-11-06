import { z } from 'zod';
import type { HistoryToolPolicy } from '../../hosting/tool-policy.js';
const historyMatch = z.strictObject({ index: z.number().int().nonnegative(), role: z.enum(['user', 'assistant']), offset: z.number().int().nonnegative(), text: z.string(), nextOffset: z.number().int().nonnegative().nullable(), totalLength: z.number().int().nonnegative() });
export const historyMatchSchema = historyMatch.readonly();
export const readMessageOutputSchema = historyMatch.extend({ transcriptId: z.string().min(1), before: z.number().int().nonnegative() }).readonly();
export const searchHistoryOutputSchema = z.strictObject({ transcriptId: z.string().min(1), before: z.number().int().nonnegative(), query: z.string(), fromIndex: z.number().int().nonnegative(), matches: z.array(historyMatchSchema).readonly(), nextIndex: z.number().int().nonnegative().nullable(), scanned: z.number().int().nonnegative() }).readonly();
export interface SearchHistoryInput {
  readonly query: string;
  readonly fromIndex?: number;
  readonly limit?: number;
}
export interface ReadMessageInput {
  readonly index: number;
  readonly offset?: number;
  readonly length?: number;
}
export type SearchHistoryOutput = z.infer<typeof searchHistoryOutputSchema>;
export type ReadMessageOutput = z.infer<typeof readMessageOutputSchema>;
export function historyInputSchemas(policy: HistoryToolPolicy) {
  return {
    search: z
      .strictObject({
        query: z
          .string()
          .min(1)
          .max(128)
          .refine((value) => !!value.trim()),
        fromIndex: z.number().int().nonnegative().optional(),
        limit: z.number().int().min(1).max(policy.maxSearchResults).optional(),
      })
      .readonly(),
    read: z.strictObject({ index: z.number().int().nonnegative(), offset: z.number().int().nonnegative().optional(), length: z.number().int().min(2).max(policy.maxReadLength).optional() }).readonly(),
  };
}
