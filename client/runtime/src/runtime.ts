import type { ConfigurationResponse, ConversationRequest, ConversationSubmissionSnapshot, MemoryObservation, Message, ObserverOverview, ExecutionRecordSnapshot, InvocationEvent, TranscriptRecord } from '@capix/protocol';
import type { ConversationTransport, ObservationTransport, TranscriptTransport } from './transport.js';
import { TranscriptReceiver, type TranscriptState } from './transcript.js';
import { ObservationReplica, ObservationSequenceError } from './observation.js';
import { ClientSubmission, SubmissionContractError, submissionFeedbackEnded, type ClientSubmissionState } from './submission.js';
import { InitializationAttempt, type ClientInitializationState } from './initialization.js';

export interface ObservationState {
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly error?: unknown;
  readonly records: ReadonlyMap<string, ExecutionRecordSnapshot>;
  readonly updates: ReadonlyMap<string, ExecutionRecordSnapshot>;
  readonly overview: ObserverOverview;
  readonly memory: MemoryObservation;
  readonly cursor?: { scopeId: string; sequence: number };
  readonly invocationEvents?: ReadonlyMap<string, InvocationEvent>;
  readonly transcriptRecords?: readonly TranscriptRecord[];
}

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
  readonly error?: unknown;
  readonly observation: ObservationState;
}

export interface ClientRuntimeOptions {
  readonly conversation: ConversationTransport;
  readonly transcripts: TranscriptTransport;
  readonly observation?: ObservationTransport;
}

/** Business delivery is independent of the optional observation capability. */
export class ClientRuntime {
  private state: ClientState = {
    initialization: { status: 'idle' },
    messages: [],
    transcripts: new Map(),
    busy: false,
    pending: '',
    contextId: '',
    answered: false,
    observation: { enabled: false, loading: false, records: new Map(), updates: new Map(), overview: { transcriptId: '', messages: [], executions: [] }, memory: { items: [] } },
  };
  private readonly listeners = new Set<() => void>();
  private initialization?: InitializationAttempt;
  private initializationNumber = 0;
  private observationSession?: AbortController;
  private observationOwner?: symbol;
  private replica?: ObservationReplica;
  private submission?: ClientSubmission;
  private feedbackSession?: AbortController;

  private readonly conversation: ConversationTransport;
  private readonly observation?: ObservationTransport;
  private readonly transcripts: TranscriptReceiver;

  constructor(options: ClientRuntimeOptions) {
    this.conversation = options.conversation;
    this.observation = options.observation;
    this.transcripts = new TranscriptReceiver(options.transcripts, (transcripts) => {
      const current = this.state.transcriptId ? transcripts.get(this.state.transcriptId) : undefined;
      this.update({ transcripts, ...(current?.snapshot ? { messages: current.snapshot.messages } : {}), ...(current?.error ? { error: current.error } : {}) });
    });
  }

  readonly getSnapshot = (): ClientState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<ClientState>) {
    const next = { ...this.state, ...change };
    const submission = next.submission;
    this.state = { ...next, busy: Boolean(submission && !submission.remote?.result), pending: submission && !submission.remote?.input && !submission.remote?.result ? submission.pending : '', contextId: submission?.remote?.executions.at(-1)?.contextId ?? '', answered: Boolean(submission?.remote?.answer) };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A consumer cannot reject already accepted source state or interrupt other subscribers.
        this.listeners.delete(listener);
      }
    }
  }

  private updateObservation(change: Partial<ObservationState>) {
    this.update({ observation: { ...this.state.observation, ...change } });
  }

  initialize(): Promise<void> {
    if (this.initialization?.running) return this.initialization.promise;
    if (this.state.initialization.status === 'succeeded' && this.state.config && this.state.transcriptId && this.state.transcripts.get(this.state.transcriptId)?.syncing) return Promise.resolve();
    const attempt = new InitializationAttempt(++this.initializationNumber);
    this.initialization = attempt;
    this.update({ initialization: attempt.snapshot, error: undefined });
    if (attempt.running) {
      void this.loadInitial(attempt).then(
        () => {
          if (!attempt.running) return;
          attempt.complete();
          this.update({ initialization: attempt.snapshot });
        },
        (error) => {
          if (!attempt.running) return;
          attempt.fail(error);
          this.update({ initialization: attempt.snapshot, error });
        },
      );
    }
    return attempt.promise;
  }

  private async loadInitial(attempt: InitializationAttempt): Promise<void> {
    await Promise.all([this.loadConfiguration(attempt), this.loadInitialTranscript(attempt)]);
    if (!attempt.running) return;
    const transcript = this.state.transcriptId ? this.state.transcripts.get(this.state.transcriptId) : undefined;
    if (!transcript?.syncing) throw transcript?.error ?? new Error('初始化结束前消息同步已停止。');
  }

  private async loadConfiguration(attempt: InitializationAttempt): Promise<void> {
    if (this.state.config) return;
    const config = await this.conversation.config();
    if (attempt.running) this.update({ config });
  }

  private async loadInitialTranscript(attempt: InitializationAttempt): Promise<void> {
    const transcript = await this.transcripts.watch(this.state.transcriptId);
    if (!attempt.running) return;
    const current = this.state.transcripts.get(transcript.id)?.snapshot ?? transcript;
    this.update({ transcriptId: current.id, messages: current.messages });
  }

  /** Load an entity only when needed, then keep its copy current until explicitly stopped. */
  loadTranscript(id: string): Promise<import('@capix/protocol').TranscriptSnapshot> {
    return this.transcripts.watch(id);
  }

  stopTranscript(id?: string): void {
    const attempt = this.initialization;
    const stopsInitialization = attempt?.running && (!id || id === (this.state.transcriptId ?? this.transcripts.defaultId));
    this.transcripts.stop(id);
    if (stopsInitialization && attempt.running) {
      attempt.stop();
      this.update({ initialization: attempt.snapshot });
    }
  }

  /** Explicitly enable live observation. Stopping it never cancels conversation work. */
  startObservation(): () => void {
    if (!this.observation) return () => {};
    const owner = Symbol('observation');
    this.observationOwner = owner;
    this.connectObservation(owner, true);
    return () => {
      if (this.observationOwner !== owner) return;
      this.observationOwner = undefined;
      this.observationSession?.abort();
      this.observationSession = undefined;
      this.updateObservation({ enabled: false, loading: false });
    };
  }

  private connectObservation(owner: symbol, resync: boolean): void {
    if (!this.observation) return;
    this.observationSession?.abort();
    const session = new AbortController();
    this.observationSession = session;
    let ready = false;
    this.updateObservation({ enabled: true, loading: true, error: undefined });
    void this.observation
      .observe((frame) => {
        if (session.signal.aborted || this.observationOwner !== owner) return;
        if (!ready && frame.type !== 'baseline') throw new ObservationSequenceError('观测连接缺少初始基线。');
        if (ready && frame.type === 'baseline') throw new ObservationSequenceError('同一连接重复提供基线。');
        const next = ObservationReplica.receive(ready ? this.replica : undefined, frame);
        if (next === this.replica) return;
        this.replica = next;
        ready = true;
        const records = frame.type === 'baseline' ? new Map(next.snapshots) : new Map([...this.state.observation.records, ...next.snapshots]);
        this.updateObservation({ loading: false, overview: next.overview, memory: next.memory, records, updates: new Map(next.snapshots), cursor: { scopeId: next.scopeId, sequence: next.sequence }, invocationEvents: next.invocationEvents, transcriptRecords: next.transcriptRecords });
      }, session.signal)
      .catch((error) => {
        if (session.signal.aborted || this.observationOwner !== owner) return;
        // At most one automatic baseline retry. Other failures remain visible and can be refreshed explicitly.
        if (resync && !sourceIncomplete(error) && sequenceFailure(error)) {
          this.connectObservation(owner, false);
          return;
        }
        session.abort();
        this.updateObservation({ loading: false, error });
      });
  }

  async refreshObservation(): Promise<void> {
    if (this.observationOwner) this.connectObservation(this.observationOwner, false);
  }

  getExecution(id: string): ExecutionRecordSnapshot | undefined {
    return this.state.observation.records.get(id);
  }

  async loadExecution(id: string, signal?: AbortSignal): Promise<ExecutionRecordSnapshot> {
    if (!this.observation) throw new Error('未接入观测能力。');
    const cached = this.getExecution(id);
    if (cached && cached.execution.status !== 'running' && cached.runtimeCall.status !== 'running') return cached;
    const session = this.observationSession;
    const snapshot = await this.observation.execution(id, signal);
    if (session !== this.observationSession) throw new Error('观测连接已更换，忽略旧详情响应。');
    const current = this.getExecution(id);
    if (current && current !== cached) return current;
    this.updateObservation({ records: new Map(this.state.observation.records).set(id, snapshot) });
    return snapshot;
  }

  source(path: string, signal?: AbortSignal) {
    if (!this.observation) return Promise.reject(new Error('未接入观测能力。'));
    return this.observation.source(path, signal);
  }

  private updateSubmission(submission: ClientSubmission): void {
    if (this.submission === submission) this.update({ submission: submission.snapshot });
  }

  /** Sends once. Interruption means feedback is unknown, not that server work failed. */
  async submit(request: ConversationRequest, accepted?: () => undefined): Promise<void> {
    if (this.submission && !this.submission.snapshot.remote?.result) throw new Error('当前提交尚未确认结束，请重新连接或明确结束跟踪。');
    if (this.state.initialization.status !== 'succeeded' || !this.state.config?.configured) throw new Error('请先完成客户端初始化与服务端模型配置。');
    const input = { ...request, messages: request.messages.map((message) => ({ ...message })) };
    const submission = new ClientSubmission(input.messages.at(-1)?.content ?? '', accepted);
    this.submission = submission;
    this.update({ submission: submission.snapshot });
    await this.connectSubmission(submission, (receive, signal) => this.conversation.submit({ submissionId: submission.id, input }, receive, signal));
  }

  /** Follow an existing identity only; never automatically resubmit its input. */
  async reconnectSubmission(): Promise<void> {
    const submission = this.submission;
    if (!submission) throw new Error('没有可重新连接的提交。');
    if (submission.snapshot.remote?.result) return;
    await this.connectSubmission(submission, (receive, signal) => this.conversation.follow(submission.id, receive, signal));
  }

  stopFollowing(): void {
    this.feedbackSession?.abort();
    this.feedbackSession = undefined;
    if (this.submission && this.submission.snapshot.feedback.status !== 'ended') {
      this.submission.feedback({ status: 'ended' });
      this.updateSubmission(this.submission);
    }
  }

  /** Relinquish local tracking explicitly. It is not cancellation or proof of remote completion. */
  releaseSubmission(): void {
    this.feedbackSession?.abort();
    this.feedbackSession = undefined;
    this.submission = undefined;
    this.update({ submission: undefined });
  }

  private async connectSubmission(submission: ClientSubmission, connect: (receive: (snapshot: ConversationSubmissionSnapshot) => void, signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.submission !== submission) return;
    this.feedbackSession?.abort();
    const session = new AbortController();
    this.feedbackSession = session;
    submission.feedback({ status: 'connecting' });
    this.updateSubmission(submission);
    const current = () => this.submission === submission && this.feedbackSession === session && !session.signal.aborted;
    if (!current()) return;
    try {
      await connect((snapshot) => {
        if (!current()) return;
        if (snapshot.input && snapshot.input.transcriptId !== this.state.transcriptId) throw new SubmissionContractError('提交输入不属于当前消息集合。');
        submission.receive(snapshot);
        this.updateSubmission(submission);
      }, session.signal);
      if (!current()) return;
      const remote = submission.snapshot.remote;
      if (!remote || !submissionFeedbackEnded(remote)) throw new Error('提交反馈连接已结束，远端结果仍未确认。');
      submission.feedback({ status: 'ended' });
    } catch (error) {
      if (!current()) return;
      submission.feedback({ status: 'interrupted', error });
    } finally {
      if (current()) {
        this.feedbackSession = undefined;
        this.updateSubmission(submission);
      }
    }
  }
}

function sequenceFailure(error: unknown): boolean {
  return error instanceof ObservationSequenceError || (error instanceof Error && error.cause instanceof ObservationSequenceError);
}

function sourceIncomplete(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'SOURCE_INCOMPLETE';
}
