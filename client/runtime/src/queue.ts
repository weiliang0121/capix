import type { ConversationRequest } from '@capix/protocol';
import type { ConversationTransport } from './transport.js';
import { ClientSubmission, type ClientSubmissionState, type SubmissionReception } from './submission.js';

export interface ClientQueueState {
  readonly waiting: readonly { readonly id: string; readonly pending: string }[];
  readonly paused: boolean;
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

/** Owns local ordering only. A lost connection never releases the current submission. */
export class ConversationQueue {
  private readonly waiting: ClientSubmission[] = [];
  private current?: ClientSubmission;
  private settled?: ClientSubmission;
  private transcriptId?: string;
  private paused = false;
  private scheduled = false;
  private blocked?: string;
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
    return Object.freeze({ waiting: Object.freeze(this.waiting.map(({ id, snapshot }) => Object.freeze({ id, pending: snapshot.pending }))), paused: this.paused, ...(this.blocked ? { blocked: this.blocked } : {}) });
  }

  get submission(): ClientSubmission | undefined {
    return this.current;
  }

  enqueue(input: ConversationRequest): { readonly id: string } {
    this.requireReady();
    if (this.waiting.length >= this.maxWaiting) throw new Error('等待队列已满，请先撤回部分消息。');
    const submission = new ClientSubmission(input);
    if (this.waiting.reduce((sum, item) => sum + item.bytes, submission.bytes) > this.maxBytes) throw new Error('等待消息总容量已满，请先撤回部分消息。');
    this.waiting.push(submission);
    this.changed();
    return Object.freeze({ id: submission.id });
  }

  /** Immediate submission preserves its connection Promise; it cannot bypass queued work. */
  prepare(input: ConversationRequest, accepted?: (submission: ClientSubmissionState) => undefined): ClientSubmission {
    if (this.current && !this.current.snapshot.remote?.result) throw new Error('当前提交尚未确认结束，请重新连接或请求取消。');
    if (this.paused || this.waiting.length) throw new Error('队列已暂停或存在等待消息，请加入队列或明确恢复。');
    this.requireReady();
    const submission = new ClientSubmission(input, accepted);
    this.replace(submission);
    return submission;
  }

  send(submission: ClientSubmission): Promise<void> {
    if (this.current !== submission || submission.dispatched || this.paused) return Promise.resolve();
    const environment = this.environment();
    if (!environment.ready || environment.transcriptId !== this.transcriptId) {
      this.blocked = '调用环境尚未就绪或消息集合已改变。';
      this.notify(this.current);
      return Promise.resolve();
    }
    this.blocked = undefined;
    return submission.send(this.transport, this.reception(submission));
  }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.changed();
  }

  resume(): void {
    if (!this.paused) {
      this.scheduleAdvance();
      return;
    }
    this.paused = false;
    this.changed();
  }

  clear(): void {
    this.waiting.splice(0);
    this.blocked = undefined;
    this.changed();
  }

  cancel(id: string): Promise<void> {
    const index = this.waiting.findIndex((item) => item.id === id);
    if (index !== -1) {
      this.waiting.splice(index, 1);
      this.changed();
      return Promise.resolve();
    }
    const submission = this.current;
    if (!submission || submission.id !== id) return Promise.reject(new Error('未找到待取消的提交。'));
    if (submission.snapshot.remote?.result) return Promise.resolve();
    this.paused = true;
    if (!submission.dispatched) {
      this.current = undefined;
      this.changed();
      return Promise.resolve();
    }
    this.changed();
    return submission.requestCancellation(this.transport, this.reception(submission));
  }

  cancelAll(): Promise<void> {
    this.paused = true;
    this.waiting.splice(0);
    const current = this.current;
    this.changed();
    return current ? this.cancel(current.id) : Promise.resolve();
  }

  async reconnect(): Promise<void> {
    const submission = this.current;
    if (!submission) throw new Error('没有可重新连接的提交。');
    if (submission.snapshot.remote?.result) return;
    const reception = this.reception(submission);
    // A pending cancellation is a control command, independent of the long feedback connection.
    if (submission.snapshot.cancellation && !submission.snapshot.remote?.cancelRequested) void submission.requestCancellation(this.transport, reception);
    await submission.connect((receive, signal) => this.transport.follow(submission.id, receive, signal), reception);
  }

  async refresh(): Promise<void> {
    const submission = this.current;
    if (!submission) throw new Error('没有可查询的提交。');
    await submission.refresh(this.transport, this.reception(submission));
  }

  stopFollowing(): void {
    const submission = this.current;
    submission?.stopFollowing();
    this.changed(submission);
  }

  release(): void {
    const previous = this.current;
    if (previous?.dispatched && !previous.snapshot.remote?.result) throw new Error('当前提交尚未确认结束，不能释放队列占用；请查询或取消。');
    this.current = undefined;
    this.changed();
    previous?.stopFollowing();
  }

  /** Initialization may unblock dispatch; entity body delivery is not a queue dependency. */
  checkEnvironment(): void {
    this.scheduleAdvance();
  }

  private requireReady(): void {
    const environment = this.environment();
    if (!environment.ready || !environment.transcriptId) throw new Error('请先完成客户端初始化与服务端模型配置。');
    if ((this.waiting.length || (this.current && !this.current.snapshot.remote?.result)) && this.transcriptId !== environment.transcriptId) throw new Error('消息集合已改变，不能将旧队列转交到新的对话。');
    this.transcriptId = environment.transcriptId;
  }

  private reception(submission: ClientSubmission): SubmissionReception {
    return { transcriptId: this.transcriptId!, changed: () => this.changed(submission) };
  }

  private replace(submission: ClientSubmission): void {
    const previous = this.current;
    this.current = submission;
    this.settled = undefined;
    this.changed(submission);
    previous?.stopFollowing();
  }

  private changed(submission?: ClientSubmission): void {
    if (submission && this.current !== submission) return;
    const current = this.current;
    const remote = current?.snapshot.remote;
    if (current && remote?.result && this.settled !== current) {
      this.settled = current;
      if (remote.result.status !== 'completed' || remote.integrity.status === 'incomplete' || current.snapshot.cancellation) this.paused = true;
    }
    this.notify(current);
    this.scheduleAdvance();
    // A failed early cancel may have raced service registration. New facts are a reason
    // to retry the control command once per revision, never the original input POST.
    if (current?.shouldRetryCancellation) void current.requestCancellation(this.transport, this.reception(current));
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
    if (this.paused) return;
    if (this.current && !this.current.dispatched) {
      void this.send(this.current);
      return;
    }
    if (!this.waiting.length || (this.current && !this.current.snapshot.remote?.result)) return;
    const environment = this.environment();
    const blocked = !environment.ready ? '请先完成客户端初始化。' : environment.transcriptId !== this.transcriptId ? '消息集合已改变，请清理旧队列。' : undefined;
    if (blocked !== this.blocked) {
      this.blocked = blocked;
      this.notify(this.current);
    }
    if (blocked || this.paused || !this.waiting.length || (this.current && !this.current.snapshot.remote?.result)) return;
    const next = this.waiting.shift()!;
    this.replace(next);
    void this.send(next);
  }
}
