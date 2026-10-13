import type { ClientTrackingLocator, ClientTrackingStore } from '@capix/client-runtime';

const trackingKey = 'capix.observer.tracking.v1';

/** Retain only this tab's locator. Runtime validates it and owns any storage failure. */
export function createSessionTrackingStore(storage: () => Pick<Storage, 'getItem' | 'setItem'> = () => window.sessionStorage): ClientTrackingStore {
  return {
    load() {
      const saved = storage().getItem(trackingKey);
      return saved === null ? undefined : (JSON.parse(saved) as ClientTrackingLocator);
    },
    save(locator) {
      const { conversationId, transcriptId, submissionId } = locator;
      storage().setItem(trackingKey, JSON.stringify({ conversationId, transcriptId, ...(submissionId ? { submissionId } : {}) }));
    },
  };
}
