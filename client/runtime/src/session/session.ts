import type { ConversationServiceInfo } from '@capix/protocol';
import { ClientSubmission, type ClientSubmissionState, type SubmissionReception } from '../submission.js';
import { TranscriptReceiver, type TranscriptState } from '../transcript.js';
import { acceptTrackingLocator, type ClientTrackingStore } from '../tracking.js';
import { validAdmission } from '../admission.js';
import { SessionConnectionError, type SessionTransport } from './transport.js';

export interface ConversationSessionState {
  readonly status: 'idle' | 'connecting' | 'ready' | 'failed' | 'stopped';
  readonly info?: ConversationServiceInfo;
  readonly transcript?: TranscriptState;
  readonly submission?: ClientSubmissionState;
  readonly error?: unknown;
  readonly trackingError?: unknown;
  readonly canSend: boolean;
  readonly canForget: boolean;
}

const retryDelays = [300, 1000, 2500] as const;

/** Coordinates one service identity; submission and transcript mechanisms own their actual facts. */
export class ConversationSession {
  private state: ConversationSessionState = Object.freeze({ status: 'idle', canSend: false, canForget: false });
  private readonly listeners = new Set<() => void>();
  private readonly transcripts: TranscriptReceiver;
  private scope?: AbortController;
  private opening?: Promise<void>;
  private current?: ClientSubmission;
  private publication = false;
  private trackingConflict = false;
  private admissionVerified = false;
  private confirmation?: { readonly submission: ClientSubmission; readonly scope: AbortController; readonly promise: Promise<void> };

  constructor(
    private readonly transport: SessionTransport,
    private readonly options: { readonly tracking?: ClientTrackingStore } = {},
  ) {
    this.transcripts = new TranscriptReceiver(transport, (states) => {
      const id = this.state.info?.transcriptId;
      if (id) this.update({ transcript: states.get(id) });
    });
  }

  get snapshot(): ConversationSessionState {
    return this.state;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  initialize(): Promise<void> {
    if (this.opening) return this.opening;
    const previous = this.scope;
    const scope = new AbortController();
    this.scope = scope;
    this.admissionVerified = false;
    this.current?.stopFollowing();
    this.transcripts.stop();
    previous?.abort();
    this.update({ status: 'connecting', error: undefined });
    const task = this.open(scope);
    this.opening = task;
    void task
      .finally(() => {
        if (this.opening === task) this.opening = undefined;
      })
      .catch(() => undefined);
    return task;
  }

  private async open(scope: AbortController): Promise<void> {
    const valid = () => this.scope === scope && !scope.signal.aborted;
    try {
      const info = await this.transport.session(AbortSignal.any([scope.signal, AbortSignal.timeout(10_000)]));
      if (!valid()) return;
      this.checkInfo(info);
      const remembered = this.loadTracking();
      this.trackingConflict = Boolean(remembered && (remembered.conversationId !== info.conversationId || remembered.transcriptId !== info.transcriptId));
      this.update({ info });
      if (this.trackingConflict) throw new Error('本地跟踪属于其他对话，请先确认并清理旧跟踪位置。');
      await this.transcripts.watch(info.transcriptId);
      if (!valid()) return;
      if (!this.current || this.current.snapshot.remote?.result) {
        const id = remembered?.submissionId ?? info.active?.submission.submissionId;
        if (id) this.current = ClientSubmission.attach({ conversationId: info.conversationId, submissionId: id }, info.transcriptId, info.active?.submission.submissionId === id ? info.active : undefined);
      }
      this.admissionVerified = !this.current || Boolean(this.current.snapshot.remote?.result && this.current.snapshot.remote.integrity.status === 'complete');
      this.update({ status: 'ready', submission: this.current?.snapshot });
      this.saveTracking();
      if (this.current && !this.current.snapshot.remote?.result) void this.follow(this.current, scope, true);
    } catch (error) {
      if (!valid()) return;
      this.transcripts.stop();
      this.update({ status: 'failed', error });
      throw error;
    }
  }

  async send(text: string): Promise<void> {
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('请输入非空文本。');
    if (new TextEncoder().encode(text).byteLength > 128 * 1024) throw new TypeError('输入过长，编码后的完整请求不能超过 128 KiB。');
    if (!this.state.canSend || !this.state.info || !this.scope) throw new Error('当前对话尚不可提交；请先确认连接与上一次结果。');
    const scope = this.scope;
    const submission = new ClientSubmission(this.state.info.conversationId, { messages: [{ role: 'user', content: text }] });
    const request = { conversationId: submission.conversationId, submissionId: submission.id, input: submission.input };
    if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 128 * 1024) throw new TypeError('输入过长，编码后的完整请求不能超过 128 KiB。');
    this.current = submission;
    this.admissionVerified = false;
    this.saveTracking(); // Save identity before POST; this is not an acknowledgement of admission.
    this.changed(submission, scope);
    await submission.send(this.transport, this.reception(submission, scope));
    if (this.owns(submission, scope)) {
      this.changed(submission, scope);
      await this.confirmAdmission(submission, scope);
      if (this.retryable(submission)) await this.follow(submission, scope, false);
    }
    const remote = submission.snapshot.remote;
    // A confirmed rejection did not consume this text. Let the composer retain it,
    // including when current tracking has already moved to another tab's active call.
    if (remote?.result?.status === 'rejected' && !remote.input) throw new Error(remote.result.error.message);
  }

  async cancel(): Promise<void> {
    if (!this.current || !this.scope || this.current.snapshot.remote?.result) return;
    const submission = this.current;
    const scope = this.scope;
    await submission.requestCancellation(this.transport, this.reception(submission, scope));
    await this.confirmAdmission(submission, scope);
  }

  reconnect(): Promise<void> {
    return this.initialize();
  }

  /** Explicit local release of unknown tracking, never cancellation or permission to replay input. */
  forget(): void {
    const submission = this.current;
    if (!submission) {
      if (!this.trackingConflict) return;
      this.trackingConflict = false;
      this.saveTracking();
      this.update({});
      void this.initialize().catch(() => undefined);
      return;
    }
    const state = submission.snapshot;
    if (!state.remote?.result && state.remote?.integrity.status !== 'incomplete' && !['interrupted', 'unavailable'].includes(state.feedback.status)) throw new Error('提交仍在跟随中，不能将它当作未知结果清除。');
    this.current = undefined;
    submission.stopFollowing();
    this.saveTracking();
    this.update({ submission: undefined });
    void this.initialize().catch(() => undefined);
  }

  stop(): void {
    const scope = this.scope;
    this.scope = undefined;
    this.opening = undefined;
    this.current?.stopFollowing();
    this.transcripts.stop();
    this.update({ status: 'stopped', submission: this.current?.snapshot });
    scope?.abort();
  }

  private owns(submission: ClientSubmission, scope: AbortController): boolean {
    return this.current === submission && this.scope === scope && !scope.signal.aborted;
  }
  private retryable(submission: ClientSubmission): boolean {
    const state = submission.snapshot;
    return !state.remote?.result && state.remote?.integrity.status !== 'incomplete' && state.feedback.status === 'interrupted' && state.feedback.error instanceof SessionConnectionError;
  }
  private reception(submission: ClientSubmission, scope: AbortController): SubmissionReception {
    return { transcriptId: this.state.info!.transcriptId, changed: () => this.changed(submission, scope), recoverPreview: (signal) => this.transport.read(submission.id, signal) };
  }
  private changed(submission: ClientSubmission, scope: AbortController): void {
    if (!this.owns(submission, scope)) return;
    this.update({ submission: submission.snapshot });
    this.saveTracking();
    void this.confirmAdmission(submission, scope);
  }

  private confirmAdmission(submission: ClientSubmission, scope: AbortController): Promise<void> {
    const remote = submission.snapshot.remote;
    if (!this.owns(submission, scope) || this.admissionVerified || !remote?.result || remote.integrity.status !== 'complete') return Promise.resolve();
    if (this.confirmation?.submission === submission && this.confirmation.scope === scope) return this.confirmation.promise;
    const promise = this.refreshService(submission, scope);
    this.confirmation = { submission, scope, promise };
    return promise;
  }

  /** A terminal submission's admission is historical; another tab may already own the service. */
  private async refreshService(submission: ClientSubmission, scope: AbortController): Promise<void> {
    try {
      const info = await this.transport.session(AbortSignal.any([scope.signal, AbortSignal.timeout(10_000)]));
      if (!this.owns(submission, scope)) return;
      this.checkInfo(info);
      if (info.active) {
        if (info.active.submission.submissionId === submission.id) throw new Error('服务将已结束的提交报告为当前执行。');
        this.current = ClientSubmission.attach({ conversationId: info.conversationId, submissionId: info.active.submission.submissionId }, info.transcriptId, info.active);
        this.admissionVerified = false;
      } else this.admissionVerified = true;
      this.update({ info, submission: this.current?.snapshot, error: undefined });
      this.saveTracking();
      if (this.current && this.current !== submission) void this.follow(this.current, scope, true);
    } catch (error) {
      if (this.owns(submission, scope)) this.update({ error });
    }
  }

  private async follow(submission: ClientSubmission, scope: AbortController, immediate: boolean): Promise<void> {
    for (let attempt = 0; attempt <= retryDelays.length && this.owns(submission, scope); attempt++) {
      if (!immediate || attempt > 0) {
        const delay = retryDelays[immediate ? attempt - 1 : attempt];
        if (delay === undefined || !(await wait(delay, scope.signal))) return;
      }
      let refreshed = false;
      try {
        await submission.refresh(this.transport, this.reception(submission, scope), scope.signal);
        refreshed = true;
      } catch {
        /* Refresh records its own unknown/failed connection state. */
      }
      if (!this.owns(submission, scope)) return;
      this.changed(submission, scope);
      if (submission.snapshot.remote?.result || submission.snapshot.remote?.integrity.status === 'incomplete' || submission.snapshot.feedback.status === 'unavailable') return;
      if (submission.snapshot.feedback.status === 'interrupted' && !this.retryable(submission)) return;
      if (refreshed) {
        await submission.connect((receive, signal) => this.transport.follow(submission.id, receive, signal), this.reception(submission, scope));
        if (!this.owns(submission, scope)) return;
        this.changed(submission, scope);
      }
      if (!this.retryable(submission)) return;
    }
  }

  private checkInfo(info: ConversationServiceInfo): void {
    if (!info || !info.conversationId || !info.transcriptId || !validAdmission(info.admission) || info.admission.conversationId !== info.conversationId || info.admission.transcriptId !== info.transcriptId) throw new Error('服务返回了不一致的对话身份。');
    if (this.state.info && (this.state.info.conversationId !== info.conversationId || this.state.info.transcriptId !== info.transcriptId)) throw new Error('服务的对话身份已改变，不能覆盖当前内容。');
    if (this.current && this.current.conversationId !== info.conversationId) throw new Error('当前提交属于其他对话，不能转交给新的服务身份。');
    if (info.active && (info.active.submission.conversationId !== info.conversationId || info.active.submission.result)) throw new Error('服务返回了无效的活动提交。');
  }
  private loadTracking() {
    try {
      const value = this.options.tracking?.load();
      return value ? acceptTrackingLocator(value) : undefined;
    } catch (trackingError) {
      this.update({ trackingError });
      return undefined;
    }
  }
  private saveTracking(): void {
    const info = this.state.info;
    if (!info || !this.options.tracking) return;
    try {
      const remote = this.current?.snapshot.remote;
      this.options.tracking.save({ conversationId: info.conversationId, transcriptId: info.transcriptId, ...(this.current && !(remote?.result && remote.integrity.status === 'complete') ? { submissionId: this.current.id } : {}) });
      if (this.state.trackingError !== undefined) this.update({ trackingError: undefined });
    } catch (trackingError) {
      this.update({ trackingError });
    }
  }
  private update(change: Partial<ConversationSessionState>): void {
    const next = { ...this.state, ...change };
    const remote = next.submission?.remote;
    const known = !next.submission || Boolean(remote?.result && remote.integrity.status === 'complete');
    const answerAvailable = !remote?.answer || (next.transcript?.snapshot?.end ?? 0) > remote.answer.index;
    const canForget = this.trackingConflict || Boolean(next.submission && (!remote?.result || remote.integrity.status === 'incomplete') && (remote?.integrity.status === 'incomplete' || ['interrupted', 'unavailable'].includes(next.submission.feedback.status)));
    this.state = Object.freeze({ ...next, canSend: next.status === 'ready' && this.admissionVerified && next.info?.admission.status === 'ready' && next.transcript?.sync.status === 'live' && known && answerAvailable, canForget });
    if (this.publication) return;
    this.publication = true;
    queueMicrotask(() => {
      this.publication = false;
      for (const listener of [...this.listeners]) {
        if (this.listeners.has(listener)) {
          try {
            listener();
          } catch {
            this.listeners.delete(listener);
          }
        }
      }
    });
  }
}

function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const aborted = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', aborted);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      resolve(true);
    }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}
