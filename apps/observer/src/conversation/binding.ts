import type { ConversationSession, ClientTrackingStore } from '@capix/client-runtime';
import type { SessionHttpTransport } from '@capix/client-http';
import type { ConversationCallDetail, ConversationInspection, ConversationRecoverySummary, ConversationRecordingState } from '@weiliang0121/capix-protocol';

type Loading = 'idle' | 'loading' | 'ready' | 'failed';
type SessionState = ConversationSession['snapshot'];
type RecordingCommand = 'start' | 'stop' | 'clear';
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
  readonly recoveryStatus: Loading | 'stale';
  readonly recoveryError?: string;
  readonly recording?: ConversationRecordingState;
  readonly recordingPending?: RecordingCommand;
  readonly recordingError?: string;
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
    readonly transport: Pick<SessionHttpTransport, 'inspection' | 'call'> & Partial<Pick<SessionHttpTransport, 'recoveries' | 'startRecording' | 'stopRecording' | 'clearRecording'>>,
  ) {
    this.#state = { session: session.snapshot, inspectionStatus: 'idle', detailStatus: 'idle', recoveryStatus: 'idle' };
  }
  readonly #listeners = new Set<() => void>();
  #frame?: number;
  #unsubscribe?: () => void;
  #inspection?: AbortController;
  #detail?: AbortController;
  #recoveries?: AbortController;
  #recording?: AbortController;
  #contentId?: string;
  #settled?: string;
  #recoveryOpening = true;
  #inspectionOpening = true;

  readonly snapshot = () => this.#state;
  readonly subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  connect(): () => void {
    const generation = ++this.#generation;
    this.#recoveryOpening = true;
    this.#inspectionOpening = true;
    this.#recording?.abort();
    this.#recording = undefined;
    this.publish({ recording: undefined, recordingPending: undefined, recordingError: undefined });
    this.invalidateRecoveries();
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
      this.#recording?.abort();
      this.#recording = undefined;
      this.invalidateRecoveries();
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
    const previous = this.#state.session;
    if (current.status === 'connecting' && previous.status !== 'connecting') {
      this.#recoveryOpening = true;
      this.#inspectionOpening = true;
      this.#recording?.abort();
      this.#recording = undefined;
      this.#inspection?.abort();
      this.#inspection = undefined;
      this.#detail?.abort();
      this.#detail = undefined;
      this.publish({ recording: undefined, recordingPending: undefined, recordingError: undefined });
    }
    if (!canInspectRecoveries(current) || !sameRecoveryBasis(previous, current)) this.invalidateRecoveries();
    this.publish({ session: current });
    const id = current.info?.transcriptId;
    if (id && id !== this.#contentId) {
      this.#contentId = id;
      this.#detail?.abort();
      this.publish({ inspection: undefined, detail: undefined, selectedCall: undefined, detailStatus: 'idle' });
      this.#inspectionOpening = true;
    }
    const openingInspection = this.#inspectionOpening && current.status === 'ready' && Boolean(id);
    if (openingInspection) {
      this.#inspectionOpening = false;
      void this.refresh();
    }
    if (this.#recoveryOpening && current.status === 'ready') {
      // Discovery belongs to initialization, not every later admission transition.
      // Resolve old local tracking first; known activity consumes this opportunity.
      if (canInspectRecoveries(current)) {
        this.#recoveryOpening = false;
        void this.refreshRecoveries();
      } else if (current.info?.admission.status !== 'ready' || current.info.active || current.submission?.feedback.status === 'following') this.#recoveryOpening = false;
    }
    const settled = current.submission?.remote?.result ? current.submission.id : undefined;
    if (settled && settled !== this.#settled) {
      this.#settled = settled;
      if (!openingInspection) void this.refresh();
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
    if (!id || this.#recording) return;
    this.#inspection?.abort();
    const request = new AbortController();
    this.#inspection = request;
    this.publish({ inspectionStatus: 'loading', inspectionError: undefined });
    try {
      const inspection: ConversationInspection = await this.transport.inspection(request.signal);
      if (this.#inspection !== request || request.signal.aborted) return;
      if (inspection.transcriptId !== id) throw new Error('检查内容不属于当前对话。');
      const previous = this.#state.inspection;
      if (previous && (previous.memories.id !== inspection.memories.id || previous.memories.sequence !== inspection.memories.sequence || previous.view.revision !== inspection.view.revision)) this.invalidateRecoveries();
      const selected = this.#state.selectedCall;
      const selectionAvailable = selected && this.#state.inspection?.recording.recorderId === inspection.recording.recorderId && inspection.recording.calls.some((call) => call.id === selected);
      if (!selectionAvailable) {
        this.#detail?.abort();
        this.#detail = undefined;
      }
      this.publish({ inspection, recording: inspection.recording, inspectionStatus: 'ready', ...(!selectionAvailable ? { selectedCall: undefined, detail: undefined, detailStatus: 'idle', detailError: undefined } : {}) });
      if (selectionAvailable) void this.selectCall(selected);
    } catch (error) {
      if (this.#inspection === request && !request.signal.aborted) this.publish({ inspectionStatus: 'failed', inspectionError: errorText(error) });
    }
  }

  /** Recording is host-owned; stopping this request never cancels the conversation. */
  async changeRecording(command: RecordingCommand): Promise<void> {
    if (this.#recording || this.session.snapshot.status !== 'ready') return;
    const state = this.#state.recording;
    if (!state) return;
    const start = this.transport.startRecording?.bind(this.transport);
    const stop = this.transport.stopRecording?.bind(this.transport);
    const clear = this.transport.clearRecording?.bind(this.transport);
    if (!start || !stop || !clear) return;
    if ((command === 'start' && state.status !== 'idle') || (command === 'stop' && state.status !== 'recording') || (command === 'clear' && state.status !== 'stopped')) return;
    const request = new AbortController();
    this.#recording = request;
    // An inspection issued before the control command cannot reinstall its old capture.
    this.#inspection?.abort();
    this.#inspection = undefined;
    this.cancelDetailRequest();
    this.publish({ recordingPending: command, recordingError: undefined });
    try {
      let recording: ConversationRecordingState;
      if (command === 'start') recording = await start(request.signal);
      else {
        if (state.status === 'idle') return;
        recording = command === 'stop' ? await stop(state.recorderId, request.signal) : await clear(state.recorderId, request.signal);
      }
      if (this.#recording !== request || request.signal.aborted) return;
      const changed = recording.recorderId !== state.recorderId;
      if (changed) this.cancelDetailRequest();
      this.publish({ recording, ...(changed ? { inspection: undefined, selectedCall: undefined, detail: undefined, detailStatus: 'idle', detailError: undefined } : {}) });
    } catch (error) {
      if (this.#recording !== request || request.signal.aborted) return;
      // A lost response does not prove the control command was not applied.
      this.publish({ recording: undefined, recordingError: errorText(error) });
    } finally {
      if (this.#recording === request && !request.signal.aborted) {
        this.#recording = undefined;
        this.publish({ recordingPending: undefined });
        await this.refresh();
      }
    }
  }

  private cancelDetailRequest(): void {
    this.#detail?.abort();
    this.#detail = undefined;
  }

  async refreshRecoveries(): Promise<void> {
    if (!this.transport.recoveries) return;
    const session = this.session.snapshot;
    if (!canInspectRecoveries(session)) {
      this.invalidateRecoveries();
      return;
    }
    if (this.#recoveries) return;
    const request = new AbortController();
    this.#recoveries = request;
    this.publish({ recoveries: undefined, recoveryStatus: 'loading', recoveryError: undefined });
    try {
      const recoveries = await this.transport.recoveries(request.signal);
      if (this.#recoveries !== request || request.signal.aborted) return;
      if (!canInspectRecoveries(this.session.snapshot) || !sameRecoveryBasis(session, this.session.snapshot)) return this.invalidateRecoveries();
      this.publish({ recoveries, recoveryStatus: 'ready' });
    } catch (error) {
      if (this.#recoveries !== request || request.signal.aborted) return;
      if (!canInspectRecoveries(this.session.snapshot) || !sameRecoveryBasis(session, this.session.snapshot)) return this.invalidateRecoveries();
      this.publish({ recoveryStatus: 'failed', recoveryError: errorText(error) });
    } finally {
      if (this.#recoveries === request) this.#recoveries = undefined;
    }
  }

  private invalidateRecoveries(): void {
    this.#recoveries?.abort();
    this.#recoveries = undefined;
    if (this.#state.recoveryStatus === 'idle' || this.#state.recoveryStatus === 'stale') return;
    this.publish({ recoveries: undefined, recoveryStatus: 'stale', recoveryError: undefined });
  }

  async selectCall(id: string): Promise<void> {
    if (this.#recording) return;
    this.#detail?.abort();
    const request = new AbortController();
    this.#detail = request;
    const recorderId = this.#state.inspection?.recording.recorderId;
    this.publish({ selectedCall: id, detail: undefined, detailStatus: 'loading', detailError: undefined });
    try {
      const detail = await this.transport.call(id, request.signal);
      if (this.#detail !== request || request.signal.aborted) return;
      if (this.#state.inspection?.recording.recorderId !== recorderId) return;
      if (detail.root.id !== id || detail.recorderId !== recorderId) throw new Error('调用详情不属于选中的记录来源。');
      this.publish({ detail, detailStatus: 'ready' });
    } catch (error) {
      if (this.#detail === request && !request.signal.aborted) this.publish({ detailStatus: 'failed', detailError: errorText(error) });
    }
  }
}

/** A candidate list is a snapshot, not a reservation or permission to resume. */
function sameRecoveryBasis(previous: SessionState, current: SessionState): boolean {
  return previous.info?.conversationId === current.info?.conversationId && previous.info?.transcriptId === current.info?.transcriptId && previous.info?.admission.status === current.info?.admission.status && previous.info?.active?.submission.submissionId === current.info?.active?.submission.submissionId && previous.submission?.id === current.submission?.id && previous.submission?.remote?.result?.status === current.submission?.remote?.result?.status && previous.transcript?.snapshot?.revision === current.transcript?.snapshot?.revision;
}

export function canInspectRecoveries(session: SessionState): boolean {
  // Service info can still say ready while a new local submission is in flight.
  // Unknown tracking remains inspectable; it does not authorize resume.
  return session.status === 'ready' && session.info?.admission.status === 'ready' && !session.info.active && (!session.submission || Boolean(session.submission.remote?.result) || session.canForget);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '操作未完成，请检查连接后重试。';
}
