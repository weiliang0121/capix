import type { ConversationSession, ClientTrackingStore } from '@capix/client-runtime';
import type { SessionHttpTransport } from '@capix/client-http';
import type { ConversationCallDetail, ConversationInspection, ConversationRecoverySummary } from '@capix/protocol';

type Loading = 'idle' | 'loading' | 'ready' | 'failed';
export interface ConversationApplicationState {
  readonly session: ConversationSession['snapshot'];
  readonly inspection?: ConversationInspection;
  readonly inspectionStatus: Loading;
  readonly inspectionError?: string;
  readonly detail?: ConversationCallDetail;
  readonly detailStatus: Loading;
  readonly detailError?: string;
  readonly selectedCall?: string;
  readonly actionError?: string;
  readonly recoveries?: readonly ConversationRecoverySummary[];
  readonly recoveryError?: string;
}

const trackingKey = 'capix.conversation.tracking.v1';
export function createConversationTrackingStore(): ClientTrackingStore {
  return {
    load() {
      const stored = sessionStorage.getItem(trackingKey);
      if (!stored) return undefined;
      const value: unknown = JSON.parse(stored);
      if (!value || typeof value !== 'object' || !('conversationId' in value) || typeof value.conversationId !== 'string' || !('transcriptId' in value) || typeof value.transcriptId !== 'string') throw new Error('本地接回位置无效。');
      if ('submissionId' in value && value.submissionId !== undefined && typeof value.submissionId !== 'string') throw new Error('本地提交位置无效。');
      return { conversationId: value.conversationId, transcriptId: value.transcriptId, ...('submissionId' in value && typeof value.submissionId === 'string' ? { submissionId: value.submissionId } : {}) };
    },
    save(value) {
      sessionStorage.setItem(trackingKey, JSON.stringify(value));
    },
  };
}

/** Browser projection and inspection requests; submission and source lifetimes stay in ClientSession. */
export class ConversationApplication {
  #state: ConversationApplicationState;
  #generation = 0;

  constructor(
    readonly session: ConversationSession,
    readonly transport: Pick<SessionHttpTransport, 'inspection' | 'call'> & Partial<Pick<SessionHttpTransport, 'recoveries'>>,
  ) {
    this.#state = { session: session.snapshot, inspectionStatus: 'idle', detailStatus: 'idle' };
  }
  readonly #listeners = new Set<() => void>();
  #frame?: number;
  #unsubscribe?: () => void;
  #inspection?: AbortController;
  #detail?: AbortController;
  #recoveries?: AbortController;
  #contentId?: string;
  #settled?: string;

  readonly snapshot = () => this.#state;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  connect(): () => void {
    const generation = ++this.#generation;
    this.#unsubscribe?.();
    this.#unsubscribe = this.session.subscribe(() => this.changed());
    void this.action(() => this.session.initialize());
    return () => {
      if (generation !== this.#generation) return;
      this.#generation++;
      this.#unsubscribe?.();
      this.#unsubscribe = undefined;
      this.session.stop();
      this.#inspection?.abort();
      this.#detail?.abort();
      this.#recoveries?.abort();
      this.#inspection = undefined;
      this.#detail = undefined;
      this.#recoveries = undefined;
      if (this.#frame !== undefined) cancelAnimationFrame(this.#frame);
      this.#frame = undefined;
      this.#contentId = undefined;
    };
  }

  private changed(): void {
    const current = this.session.snapshot;
    this.publish({ session: current });
    const id = current.info?.transcriptId;
    if (id && id !== this.#contentId) {
      this.#contentId = id;
      this.#detail?.abort();
      this.publish({ inspection: undefined, detail: undefined, selectedCall: undefined, detailStatus: 'idle', recoveries: undefined, recoveryError: undefined });
      void this.refresh();
    }
    const settled = current.submission?.remote?.result ? current.submission.id : undefined;
    if (settled && settled !== this.#settled) {
      this.#settled = settled;
      void this.refresh();
    }
  }

  private publish(change: Partial<ConversationApplicationState>): void {
    this.#state = { ...this.#state, ...change };
    if (this.#frame !== undefined) return;
    this.#frame = requestAnimationFrame(() => {
      this.#frame = undefined;
      for (const listener of this.#listeners) listener();
    });
  }

  async action(work: () => void | Promise<void>): Promise<void> {
    const generation = this.#generation;
    this.publish({ actionError: undefined });
    try {
      await work();
    } catch (error) {
      if (generation === this.#generation) this.publish({ actionError: errorText(error) });
    }
  }

  async refresh(): Promise<void> {
    const id = this.session.snapshot.info?.transcriptId;
    if (!id) return;
    void this.refreshRecoveries();
    this.#inspection?.abort();
    const request = new AbortController();
    this.#inspection = request;
    this.publish({ inspectionStatus: 'loading', inspectionError: undefined });
    try {
      const inspection = await this.transport.inspection(request.signal);
      if (this.#inspection !== request || request.signal.aborted) return;
      if (inspection.transcriptId !== id) throw new Error('检查内容不属于当前对话。');
      const selected = this.#state.selectedCall;
      const selectionAvailable = selected && this.#state.inspection?.recording.recorderId === inspection.recording.recorderId && inspection.recording.calls.some((call) => call.id === selected);
      if (!selectionAvailable) {
        this.#detail?.abort();
        this.#detail = undefined;
      }
      this.publish({ inspection, inspectionStatus: 'ready', ...(!selectionAvailable ? { selectedCall: undefined, detail: undefined, detailStatus: 'idle', detailError: undefined } : {}) });
      if (selectionAvailable) void this.selectCall(selected);
    } catch (error) {
      if (this.#inspection === request && !request.signal.aborted) this.publish({ inspectionStatus: 'failed', inspectionError: errorText(error) });
    }
  }

  async refreshRecoveries(): Promise<void> {
    if (!this.transport.recoveries) return;
    this.#recoveries?.abort();
    const request = new AbortController();
    this.#recoveries = request;
    this.publish({ recoveryError: undefined });
    try {
      const recoveries = await this.transport.recoveries(request.signal);
      if (this.#recoveries === request && !request.signal.aborted) this.publish({ recoveries });
    } catch (error) {
      if (this.#recoveries === request && !request.signal.aborted) this.publish({ recoveryError: errorText(error) });
    }
  }

  async selectCall(id: string): Promise<void> {
    this.#detail?.abort();
    const request = new AbortController();
    this.#detail = request;
    const recorderId = this.#state.inspection?.recording.recorderId;
    this.publish({ selectedCall: id, detail: undefined, detailStatus: 'loading', detailError: undefined });
    try {
      const detail = await this.transport.call(id, request.signal);
      if (this.#detail !== request || request.signal.aborted) return;
      if (detail.root.id !== id || detail.recorderId !== recorderId) throw new Error('调用详情不属于选中的记录来源。');
      this.publish({ detail, detailStatus: 'ready' });
    } catch (error) {
      if (this.#detail === request && !request.signal.aborted) this.publish({ detailStatus: 'failed', detailError: errorText(error) });
    }
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请检查连接后重试。';
}
