import type { ConfigurationResponse, ConversationRequest, ConversationSubmissionSnapshot, Message, ExecutionRecordSnapshot } from '@capix/protocol';
import type { ConversationTransport, ObservationTransport, TranscriptTransport } from './transport.js';
import { TranscriptReceiver, type TranscriptState } from './transcript.js';
import { ObservationReceiver, type ObservationState } from './observation/receiver.js';
import { ClientSubmission, type ClientSubmissionState } from './submission.js';
import { InitializationAttempt, type ClientInitializationState } from './initialization.js';
import { coordinateConversation, type ContentAvailability } from './conversation.js';

export interface ClientState {
  readonly initialization: ClientInitializationState;
  readonly config?: ConfigurationResponse;
  readonly messages: readonly Readonly<Message>[];
  readonly transcriptId?: string;
  readonly transcripts: ReadonlyMap<string, TranscriptState>;
  readonly submission?: ClientSubmissionState;
  readonly busy: boolean;
  readonly pending: string;
  readonly contextId: string;
  readonly answered: boolean;
  readonly inputAvailability: ContentAvailability;
  readonly answerAvailability: ContentAvailability;
  readonly error?: unknown;
  readonly observation: ObservationState;
}

export interface ClientRuntimeOptions {
  readonly conversation: ConversationTransport;
  readonly transcripts: TranscriptTransport;
  readonly observation?: ObservationTransport;
}

type ClientSources = Pick<ClientState, 'initialization' | 'config' | 'transcriptId' | 'transcripts' | 'submission' | 'error' | 'observation'>;

/** Business delivery is independent of the optional observation capability. */
export class ClientRuntime {
  private sources: ClientSources;
  private state: ClientState;
  private dirty = false;
  private scheduled = false;
  private publishing = false;
  private readonly acceptances = new Set<ClientSubmission>();
  private readonly listeners = new Set<() => void>();
  private initialization?: InitializationAttempt;
  private initializationNumber = 0;
  private submission?: ClientSubmission;

  private readonly conversation: ConversationTransport;
  private readonly observation: ObservationReceiver;
  private readonly transcripts: TranscriptReceiver;

  constructor(options: ClientRuntimeOptions) {
    this.conversation = options.conversation;
    this.observation = new ObservationReceiver(options.observation, (observation) => {
      this.update({ observation });
    });
    this.transcripts = new TranscriptReceiver(options.transcripts, (transcripts) => {
      this.update({ transcripts });
    });
    this.sources = { initialization: { status: 'idle' }, transcripts: new Map(), observation: this.observation.snapshot };
    this.state = Object.freeze({ ...this.sources, ...coordinateConversation(this.sources) });
  }

  readonly getSnapshot = (): ClientState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<ClientSources>): void {
    this.sources = { ...this.sources, ...change };
    this.dirty = true;
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.publish();
    });
  }

  /** Publish a coherent read model. Reentrant commands affect the next publication only. */
  private publish(): void {
    if (!this.dirty || this.publishing) return;
    this.publishing = true;
    this.dirty = false;
    this.state = Object.freeze({ ...this.sources, ...coordinateConversation(this.sources) });
    const acceptances = [...this.acceptances].map((submission) => ({ submission, snapshot: submission.snapshot }));
    this.acceptances.clear();
    const listeners = [...this.listeners];
    try {
      for (const listener of listeners) {
        if (!this.listeners.has(listener)) continue;
        try {
          listener();
        } catch {
          // A consumer cannot reject source facts or interrupt other subscribers.
          this.listeners.delete(listener);
        }
      }
      for (const { submission, snapshot } of acceptances) {
        submission.publishAcceptance(snapshot);
        if (submission.snapshot !== snapshot) this.updateSubmission(submission);
      }
    } finally {
      this.publishing = false;
    }
  }

  initialize(): Promise<void> {
    if (this.initialization?.running) return this.initialization.promise;
    if (this.sources.initialization.status === 'succeeded' && this.sources.config && this.sources.transcriptId && this.sources.transcripts.get(this.sources.transcriptId)?.syncing) return Promise.resolve();
    const attempt = new InitializationAttempt(++this.initializationNumber);
    this.initialization = attempt;
    this.update({ initialization: attempt.snapshot, error: undefined });
    this.publish();
    if (attempt.running) {
      void this.loadInitial(attempt).then(
        () => {
          if (!attempt.running) return;
          attempt.complete();
          this.update({ initialization: attempt.snapshot });
          this.publish();
        },
        (error) => {
          if (!attempt.running) return;
          attempt.fail(error);
          this.update({ initialization: attempt.snapshot, error });
          this.publish();
        },
      );
    }
    return attempt.promise;
  }

  private async loadInitial(attempt: InitializationAttempt): Promise<void> {
    await Promise.all([this.loadConfiguration(attempt), this.loadInitialTranscript(attempt)]);
    if (!attempt.running) return;
    const transcript = this.sources.transcriptId ? this.sources.transcripts.get(this.sources.transcriptId) : undefined;
    if (!transcript?.syncing) throw transcript?.error ?? new Error('初始化结束前消息同步已停止。');
  }

  private async loadConfiguration(attempt: InitializationAttempt): Promise<void> {
    if (this.sources.config) return;
    const config = await this.conversation.config();
    if (attempt.running) this.update({ config: Object.freeze({ ...config }) });
  }

  private async loadInitialTranscript(attempt: InitializationAttempt): Promise<void> {
    const transcript = await this.transcripts.watch(this.sources.transcriptId);
    if (!attempt.running) return;
    const current = this.sources.transcripts.get(transcript.id)?.snapshot ?? transcript;
    this.update({ transcriptId: current.id });
  }

  /** Load an entity only when needed, then keep its copy current until explicitly stopped. */
  loadTranscript(id: string): Promise<import('@capix/protocol').TranscriptSnapshot> {
    return this.transcripts.watch(id);
  }

  stopTranscript(id?: string): void {
    const attempt = this.initialization;
    const stopsInitialization = attempt?.running && (!id || id === (this.sources.transcriptId ?? this.transcripts.defaultId));
    this.transcripts.stop(id);
    if (stopsInitialization && attempt.running) {
      attempt.stop();
      this.update({ initialization: attempt.snapshot });
    }
    this.publish();
  }

  /** Explicitly enable live observation. Stopping it never cancels conversation work. */
  startObservation(): () => void {
    return this.observation.start();
  }

  async refreshObservation(): Promise<void> {
    this.observation.refresh();
  }

  getExecution(id: string): ExecutionRecordSnapshot | undefined {
    return this.observation.getExecution(id);
  }

  loadExecution(id: string, signal?: AbortSignal): Promise<ExecutionRecordSnapshot> {
    return this.observation.loadExecution(id, signal);
  }

  source(path: string, signal?: AbortSignal) {
    return this.observation.source(path, signal);
  }

  private updateSubmission(submission: ClientSubmission): void {
    if (this.submission !== submission) return;
    if (submission.acceptancePending) this.acceptances.add(submission);
    if (this.sources.submission !== submission.snapshot) this.update({ submission: submission.snapshot });
  }

  /** Sends once. Interruption means feedback is unknown, not that server work failed. */
  async submit(request: ConversationRequest, accepted?: (submission: ClientSubmissionState) => undefined): Promise<void> {
    this.publish();
    if (this.submission && !this.submission.snapshot.remote?.result) throw new Error('当前提交尚未确认结束，请重新连接或明确结束跟踪。');
    if (this.sources.initialization.status !== 'succeeded' || !this.sources.config?.configured) throw new Error('请先完成客户端初始化与服务端模型配置。');
    const input = { ...request, messages: request.messages.map((message) => ({ ...message })) };
    const submission = new ClientSubmission(input.messages.at(-1)?.content ?? '', accepted);
    const previous = this.submission;
    this.submission = submission;
    this.update({ submission: submission.snapshot });
    previous?.stopFollowing();
    this.publish();
    await this.connectSubmission(submission, (receive, signal) => this.conversation.submit({ submissionId: submission.id, input }, receive, signal));
  }

  /** Follow an existing identity only; never automatically resubmit its input. */
  async reconnectSubmission(): Promise<void> {
    const submission = this.submission;
    this.publish();
    if (this.submission !== submission) return;
    if (!submission) throw new Error('没有可重新连接的提交。');
    if (submission.snapshot.remote?.result) return;
    await this.connectSubmission(submission, (receive, signal) => this.conversation.follow(submission.id, receive, signal));
  }

  stopFollowing(): void {
    const submission = this.submission;
    this.publish();
    if (this.submission !== submission) return;
    if (submission) {
      submission.stopFollowing();
      this.updateSubmission(submission);
    }
    this.publish();
  }

  /** Relinquish local tracking explicitly. It is not cancellation or proof of remote completion. */
  releaseSubmission(): void {
    const submission = this.submission;
    this.publish();
    if (this.submission !== submission) return;
    this.submission = undefined;
    this.update({ submission: undefined });
    submission?.stopFollowing();
    this.publish();
  }

  private async connectSubmission(submission: ClientSubmission, connect: (receive: (snapshot: ConversationSubmissionSnapshot) => void, signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.submission !== submission) return;
    const transcriptId = this.sources.transcriptId;
    if (!transcriptId) throw new Error('请先完成客户端消息集合初始化。');
    await submission.connect(connect, { transcriptId, changed: () => this.updateSubmission(submission) });
  }
}
