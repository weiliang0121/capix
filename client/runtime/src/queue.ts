import type { ConversationAdmission, ConversationRequest, FileTask } from '@capix/protocol';
import type { ConversationTransport } from './transport.js';
import { acceptConversationRequest } from './request.js';
import { validAdmission } from './admission.js';
import { ClientSubmission, type ClientSubmissionState, type SubmissionReception } from './submission.js';

export interface ClientQueueState {
  readonly waiting: readonly { readonly id: string; readonly pending: string; readonly fileTask?: FileTask }[];
  readonly blocked?: string;
}
export interface ConversationQueueOptions {
  readonly maxWaiting?: number;
  readonly maxBytes?: number;
}
interface QueueEnvironment {
  readonly ready: boolean;
  readonly transcriptId?: string;
}
type ConfirmationKind = 'admission' | 'result';

/** One locally accepted input can survive several explicitly rejected admission attempts. */
class QueueEntry {
  readonly id = crypto.randomUUID();
  readonly input: ConversationRequest;
  readonly bytes: number;
  attempt?: ClientSubmission;

  constructor(
    input: ConversationRequest,
    private readonly notifyAccepted?: (submission: ClientSubmissionState) => undefined,
  ) {
    const accepted = acceptConversationRequest(input);
    this.input = accepted.input;
    this.bytes = accepted.bytes;
  }

  get pending(): string {
    return this.input.messages.at(-1)!.content;
  }

  create(): ClientSubmission {
    this.attempt = new ClientSubmission(this.input, this.notifyAccepted, this.id);
    return this.attempt;
  }
}

/** Orders local inputs. Availability never proves that an unknown submission did not run. */
export class ConversationQueue {
  private readonly waiting: QueueEntry[] = [];
  private current?: ClientSubmission;
  private active?: QueueEntry;
  private settled?: ClientSubmission;
  private transcriptId?: string;
  private scheduled = false;
  private blocked?: string;
  private needsAdmission = false;
  private admissionMismatch = false;
  private automatic = true;
  private probe?: { readonly controller: AbortController; readonly kind: ConfirmationKind };
  private retryTimer?: ReturnType<typeof setTimeout> & { unref?: () => void };
  private retryKind?: ConfirmationKind;
  private retries = 0;
  private readonly maxWaiting: number;
  private readonly maxBytes: number;

  constructor(
    private readonly transport: ConversationTransport,
    private readonly environment: () => QueueEnvironment,
    private readonly notify: (submission: ClientSubmission | undefined) => void,
    options: ConversationQueueOptions = {},
  ) {
    this.maxWaiting = options.maxWaiting ?? 32;
    this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxWaiting) || this.maxWaiting < 1 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new TypeError('Invalid conversation queue capacity');
  }

  get snapshot(): ClientQueueState {
    return Object.freeze({ waiting: Object.freeze(this.waiting.map(({ id, pending, input }) => Object.freeze({ id, pending, ...(input.fileTask ? { fileTask: input.fileTask } : {}) }))), ...(this.blocked ? { blocked: this.blocked } : {}) });
  }

  get submission(): ClientSubmission | undefined {
    return this.current;
  }

  enqueue(input: ConversationRequest): { readonly id: string } {
    this.requireReady();
    if (this.waiting.length >= this.maxWaiting) throw new Error('等待队列已满，请先撤回部分消息。');
    const entry = new QueueEntry(input);
    if (this.waiting.reduce((sum, item) => sum + item.bytes, entry.bytes) > this.maxBytes) throw new Error('等待消息总容量已满，请先撤回部分消息。');
    this.waiting.push(entry);
    this.changed();
    return Object.freeze({ id: entry.id });
  }

  /** Immediate submission cannot bypass waiting inputs. Its POST remains the final admission. */
  prepare(input: ConversationRequest, accepted?: (submission: ClientSubmissionState) => undefined): ClientSubmission {
    if (this.current && !this.current.snapshot.remote?.result) throw new Error('当前提交尚未确认结束，请重新连接或请求取消。');
    if (this.waiting.length) throw new Error('已有等待消息，请依次发送。');
    this.requireReady();
    const entry = new QueueEntry(input, accepted);
    const submission = entry.create();
    this.replace(entry, submission);
    return submission;
  }

  send(submission: ClientSubmission): Promise<void> {
    if (this.current !== submission || submission.dispatched) return Promise.resolve();
    const environment = this.environment();
    if (!environment.ready || environment.transcriptId !== this.transcriptId) {
      this.setBlocked('调用环境尚未就绪或消息集合已改变。');
      return Promise.resolve();
    }
    this.needsAdmission = true;
    this.setBlocked(undefined);
    if (this.current !== submission) return Promise.resolve();
    const currentEnvironment = this.environment();
    if (!currentEnvironment.ready || currentEnvironment.transcriptId !== this.transcriptId) {
      this.setBlocked('调用环境尚未就绪或消息集合已改变。');
      return Promise.resolve();
    }
    return submission.send(this.transport, this.reception(submission));
  }

  clear(): void {
    if (!this.waiting.length) return;
    const removedCurrent = this.waiting.some((item) => item.id === this.current?.snapshot.queueId);
    this.waiting.splice(0);
    this.stopConfirmation('admission');
    if (removedCurrent && this.current?.snapshot.remote?.result) this.current = undefined;
    this.admissionMismatch = false;
    this.blocked = undefined;
    this.changed();
  }

  cancel(id: string): Promise<void> {
    const index = this.waiting.findIndex((item) => item.id === id || item.attempt?.id === id);
    if (index !== -1) {
      const entry = this.waiting.splice(index, 1)[0]!;
      if (index === 0) this.stopConfirmation('admission');
      if (this.current?.snapshot.queueId === entry.id && this.current.snapshot.remote?.result) this.current = undefined;
      if (!this.waiting.length) this.admissionMismatch = false;
      this.blocked = undefined;
      this.changed();
      return Promise.resolve();
    }
    const submission = this.current;
    if (!submission || (submission.id !== id && submission.snapshot.queueId !== id)) return Promise.reject(new Error('未找到待取消的提交。'));
    if (submission.snapshot.remote?.result) return Promise.resolve();
    if (!submission.dispatched) {
      this.current = undefined;
      this.active = undefined;
      this.changed();
      return Promise.resolve();
    }
    this.automatic = true;
    return submission.requestCancellation(this.transport, this.reception(submission));
  }

  cancelAll(): Promise<void> {
    const current = this.current;
    this.clear();
    return current && this.current === current ? this.cancel(current.id) : Promise.resolve();
  }

  async reconnect(): Promise<void> {
    const submission = this.current;
    if (!submission) throw new Error('没有可重新连接的提交。');
    if (submission.snapshot.remote?.result) return;
    this.stopConfirmation('result');
    this.automatic = true;
    const reception = this.reception(submission);
    if (submission.snapshot.cancellation && !submission.snapshot.remote?.cancelRequested) void submission.requestCancellation(this.transport, reception);
    await submission.connect((receive, signal) => this.transport.follow(submission.id, receive, signal), reception);
  }

  async refresh(): Promise<void> {
    const submission = this.current;
    if (!submission) throw new Error('没有可查询的提交。');
    await submission.refresh(this.transport, this.reception(submission));
  }

  stopFollowing(): void {
    this.automatic = false;
    this.stopConfirmation('result');
    const submission = this.current;
    submission?.stopFollowing();
    this.changed(submission);
  }

  release(): void {
    const previous = this.current;
    if (previous?.dispatched && !previous.snapshot.remote?.result) throw new Error('当前提交尚未确认结束，不能释放队列占用；请查询或取消。');
    this.stopConfirmation('result');
    this.current = undefined;
    this.active = undefined;
    this.changed();
    previous?.stopFollowing();
  }

  /** Entity body delivery is not a dispatch dependency. */
  checkEnvironment(): void {
    this.scheduleAdvance();
  }

  private requireReady(): void {
    const environment = this.environment();
    if (!environment.ready || !environment.transcriptId) throw new Error('请先完成客户端初始化与服务端模型配置。');
    if ((this.waiting.length || (this.current && !this.current.snapshot.remote?.result)) && this.transcriptId !== environment.transcriptId) throw new Error('消息集合已改变，不能将旧队列转交到新的对话。');
    if (this.transcriptId !== environment.transcriptId) {
      this.needsAdmission = false;
      this.admissionMismatch = false;
    }
    this.transcriptId = environment.transcriptId;
  }

  private reception(submission: ClientSubmission): SubmissionReception {
    return { transcriptId: this.transcriptId!, changed: () => this.changed(submission) };
  }

  private replace(entry: QueueEntry, submission: ClientSubmission): void {
    const previous = this.current;
    this.current = submission;
    this.active = entry;
    this.settled = undefined;
    this.automatic = true;
    this.stopConfirmation();
    this.changed(submission);
    previous?.stopFollowing();
  }

  private changed(submission?: ClientSubmission): void {
    if (submission && this.current !== submission) return;
    const current = this.current;
    const remote = current?.snapshot.remote;
    if (current && remote?.result && this.settled !== current) {
      this.settled = current;
      this.stopConfirmation('result');
      const entry = this.active;
      this.active = undefined;
      this.needsAdmission = remote.admission?.status !== 'ready' || remote.admission.transcriptId !== this.transcriptId;
      if (remote.result.status === 'rejected' && remote.result.retry === 'admission' && entry && !current.snapshot.cancellation) {
        this.waiting.unshift(entry);
        this.needsAdmission = true;
        this.blocked = admissionMessage(remote.admission) ?? '服务暂未接纳，正在等待重新确认。';
        this.retry('admission');
      } else {
        this.blocked = undefined;
        this.retries = 0;
      }
    }
    this.notify(current);
    this.scheduleAdvance();
    if (this.current === current && current?.shouldRetryCancellation) void current.requestCancellation(this.transport, this.reception(current));
  }

  private scheduleAdvance(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.advance();
    });
  }

  private advance(): void {
    const current = this.current;
    if (current && !current.snapshot.remote?.result) {
      if (!current.dispatched) void this.send(current);
      else if (current.snapshot.feedback.status === 'interrupted' || current.snapshot.feedback.status === 'ended') {
        this.setBlocked('当前提交结果尚未确认，等待服务端确认后继续。');
        if (this.automatic) this.retry('result');
      }
      return;
    }
    if (!this.waiting.length) {
      this.stopConfirmation('admission');
      this.setBlocked(undefined);
      return;
    }
    const environment = this.environment();
    const blocked = !environment.ready ? '请先完成客户端初始化。' : environment.transcriptId !== this.transcriptId || this.admissionMismatch ? '消息集合已改变，请撤回旧队列。' : undefined;
    if (blocked) {
      this.stopConfirmation('admission');
      this.setBlocked(blocked);
      return;
    }
    if (this.probe || this.retryTimer !== undefined) return;
    if (this.needsAdmission) {
      this.confirmAdmission();
      return;
    }
    const next = this.waiting.shift()!;
    const submission = next.create();
    this.replace(next, submission);
    void this.send(submission);
  }

  private confirmAdmission(): void {
    const head = this.waiting[0];
    if (!head) return;
    const probe = { controller: new AbortController(), kind: 'admission' as const };
    this.probe = probe;
    const signal = AbortSignal.any([probe.controller.signal, AbortSignal.timeout(10_000)]);
    const owns = () => this.probe === probe && !probe.controller.signal.aborted && this.waiting[0] === head;
    this.setBlocked('正在确认服务是否可以接纳…');
    if (!owns()) return;
    void Promise.resolve()
      .then(() => {
        if (!owns()) return;
        return this.transport.admission(signal);
      })
      .then((admission) => {
        if (!owns()) return;
        signal.throwIfAborted();
        if (!validAdmission(admission)) throw new TypeError('服务接纳状态无效。');
        if (admission.transcriptId !== this.transcriptId) {
          this.admissionMismatch = true;
          this.setBlocked('消息集合已改变，请撤回旧队列。');
          return;
        }
        this.needsAdmission = admission.status !== 'ready';
        this.setBlocked(admissionMessage(admission));
      })
      .catch(() => {
        if (owns()) this.setBlocked('无法确认服务是否可以接纳，正在重试确认。');
      })
      .finally(() => {
        if (!owns()) return;
        this.probe = undefined;
        if (this.admissionMismatch) return;
        if (this.needsAdmission) this.retry('admission');
        else this.scheduleAdvance();
      });
  }

  private confirmResult(): void {
    const submission = this.current;
    if (!submission || submission.snapshot.remote?.result || !this.automatic || this.probe) return;
    const probe = { controller: new AbortController(), kind: 'result' as const };
    this.probe = probe;
    void submission
      .refresh(this.transport, this.reception(submission), probe.controller.signal)
      .catch(() => {
        if (this.probe === probe && this.current === submission) this.setBlocked('当前提交结果尚未确认，正在重试查询。');
      })
      .finally(() => {
        if (this.probe !== probe) return;
        this.probe = undefined;
        if (this.current === submission && !submission.snapshot.remote?.result && this.automatic) this.retry('result');
      });
  }

  private retry(kind: ConfirmationKind): void {
    if (this.probe || this.retryTimer !== undefined || (kind === 'admission' && !this.waiting.length) || (kind === 'result' && !this.automatic)) return;
    const delay = Math.min(250 * 2 ** Math.min(this.retries++, 5), 8000);
    this.retryKind = kind;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.retryKind = undefined;
      if (kind === 'result') this.confirmResult();
      else this.scheduleAdvance();
    }, delay);
    this.retryTimer.unref?.();
  }

  private stopConfirmation(kind?: ConfirmationKind): void {
    if (this.retryTimer !== undefined && (!kind || this.retryKind === kind)) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      this.retryKind = undefined;
    }
    const probe = this.probe;
    if (probe && (!kind || probe.kind === kind)) {
      this.probe = undefined;
      probe.controller.abort();
    }
  }

  private setBlocked(blocked: string | undefined): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    this.notify(this.current);
  }
}

function admissionMessage(admission: ConversationAdmission | undefined): string | undefined {
  if (admission?.status === 'busy') return '服务正在处理其他请求，等待发送。';
  if (admission?.status === 'unavailable') return `服务暂不可用：${admission.error.message}`;
  return undefined;
}
