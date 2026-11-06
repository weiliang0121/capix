import type { ArchiveAdmissionPolicy } from './archive-admission.js';

export type ConversationAnswerMode = 'material' | 'tools';

/** Host retention policy, independent of model and per-operation hard limits.
 * Headroom is an empirical buffer, not a reservation or an execution upper bound.
 */
export const defaultArchiveAdmissionPolicy: ArchiveAdmissionPolicy = Object.freeze({ thresholdBytes: 2 * 1024 * 1024 * 1024, headroomBytes: 512 * 1024 * 1024, maxPendingReplyBytes: 2 * 1024 * 1024 });

export function resolveArchiveAdmissionPolicy(options: Partial<ArchiveAdmissionPolicy> = {}): ArchiveAdmissionPolicy {
  const result = { ...defaultArchiveAdmissionPolicy, ...options };
  for (const value of Object.values(result)) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Archive threshold and buffers must be positive safe byte counts');
  if (result.headroomBytes >= result.thresholdBytes) throw new TypeError('Archive headroom must be smaller than its admission threshold');
  return Object.freeze(result);
}

export function parseAnswerMode(value: string | undefined): ConversationAnswerMode {
  if (value === undefined || value === 'material') return 'material';
  if (value === 'tools') return 'tools';
  throw new TypeError('--answer-mode must be material or tools');
}
