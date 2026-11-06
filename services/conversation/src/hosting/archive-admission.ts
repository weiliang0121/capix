import type { ConversationArchiveUsage } from '../persistence/budget.js';

export interface ArchiveAdmissionPolicy {
  /** Admission reference, not a hard quota on writes made by admitted work. */
  readonly thresholdBytes: number;
  readonly headroomBytes: number;
  readonly maxPendingReplyBytes: number;
}
export class ConversationArchiveFull extends Error {
  readonly code = 'CONVERSATION_ARCHIVE_FULL';
  constructor(
    readonly usage: ConversationArchiveUsage,
    readonly estimatedBytes: number,
    readonly thresholdBytes: number,
  ) {
    super(`对话归档达到入口门槛：交换 ${usage.exchangesBytes} bytes，模型交互 ${usage.interactionsBytes} bytes，CP ${usage.checkpointBytes} bytes；含在途反馈及增长缓冲的估计为 ${estimatedBytes} bytes，参考上限 ${thresholdBytes} bytes。现有数据保留，只读访问仍可用。`);
    this.name = 'ConversationArchiveFull';
  }
}

/** Host entry gate shared by material/tool modes. Never call from a persistence commit. */
export function assertArchiveAdmission(usage: ConversationArchiveUsage, pendingInteractions: number, policy: ArchiveAdmissionPolicy): void {
  const parts = [usage.exchangesBytes, usage.interactionsBytes, usage.checkpointBytes];
  if (parts.some((value) => !Number.isSafeInteger(value) || value < 0) || !Number.isSafeInteger(usage.totalBytes) || parts.reduce((sum, value) => sum + value, 0) !== usage.totalBytes) throw new TypeError('Invalid conversation archive usage');
  for (const value of [policy.thresholdBytes, policy.headroomBytes, policy.maxPendingReplyBytes]) if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Archive threshold and buffers must be positive safe byte counts');
  if (policy.headroomBytes >= policy.thresholdBytes || !Number.isSafeInteger(pendingInteractions) || pendingInteractions < 0) throw new TypeError('Invalid archive headroom or pending interaction count');
  const estimated = usage.totalBytes + pendingInteractions * policy.maxPendingReplyBytes + policy.headroomBytes;
  if (!Number.isSafeInteger(estimated) || estimated >= policy.thresholdBytes) throw new ConversationArchiveFull(usage, estimated, policy.thresholdBytes);
}
