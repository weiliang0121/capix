/** A local locator, never evidence of service admission, completion or execution recovery. */
export interface ClientTrackingLocator {
  readonly conversationId: string;
  readonly transcriptId: string;
  readonly submissionId?: string;
}

/** Optional host storage. No request body, waiting queue or server snapshot is persisted here. */
export interface ClientTrackingStore {
  load(): ClientTrackingLocator | undefined;
  save(locator: ClientTrackingLocator): void;
}

export function acceptTrackingLocator(value: ClientTrackingLocator): ClientTrackingLocator {
  const identity = (id: unknown) => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
  if (!value || !identity(value.conversationId) || !identity(value.transcriptId) || (value.submissionId !== undefined && !identity(value.submissionId))) throw new TypeError('本地接回位置无效。');
  return Object.freeze({ conversationId: value.conversationId, transcriptId: value.transcriptId, ...(value.submissionId ? { submissionId: value.submissionId } : {}) });
}
