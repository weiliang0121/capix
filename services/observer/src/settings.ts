import { z } from 'zod';
import type { ModelSettings } from '@capix-observer/protocol';
import { RuntimeError } from '@capix-observer/runtime';

// Configuration acceptance has always selected known fields, unlike strict model outputs.
const settingsSchema = z.object({
  model: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  contextBudget: z.int().min(256).max(1_000_000),
  maxOutputTokens: z.int().min(64).max(8192),
  timeoutMs: z.int().min(1000).max(180000),
}) satisfies z.ZodType<ModelSettings>;

export function validateSettings(value: unknown): ModelSettings {
  const parsed = settingsSchema.safeParse(value);
  if (!parsed.success) throw new RuntimeError('INVALID_SETTINGS', '模型配置无效；容量 256–1000000，输出 64–8192，超时 1000–180000 ms。', { issues: parsed.error.issues });
  return parsed.data;
}
