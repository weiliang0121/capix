import type { ConfigurationResponse, ConversationUpdate, ExecutionRequest, MemoryObservation, Message, ObserverOverview, RuntimeSnapshot, InvocationEvent, TranscriptRecord } from '@capix-observer/protocol';
import type { ConversationTransport, ObservationTransport, TranscriptTransport } from './transport.js';
import { TranscriptReceiver, type TranscriptState } from './transcript.js';
import { ObservationReplica, ObservationSequenceError } from './observation.js';

export interface ObservationState {
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly error?: unknown;
  readonly records: ReadonlyMap<string, RuntimeSnapshot>;
  readonly updates: ReadonlyMap<string, RuntimeSnapshot>;
  readonly overview: ObserverOverview;
  readonly memory: MemoryObservation;
  readonly cursor?: { scopeId: string; sequence: number };
  readonly invocations?: ReadonlyMap<string, InvocationEvent>;
  readonly transcriptRecords?: readonly TranscriptRecord[];
}

export interface ClientState {
  readonly config?: ConfigurationResponse;
  readonly messages: readonly Readonly<Message>[];
  readonly transcriptId?: string;
  readonly transcripts: ReadonlyMap<string, TranscriptState>;
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
    messages: [],
    transcripts: new Map(),
    busy: false,
    pending: '',
    contextId: '',
    answered: false,
    observation: { enabled: false, loading: false, records: new Map(), updates: new Map(), overview: { transcriptId: '', messages: [], executions: [] }, memory: { items: [] } },
  };
  private readonly listeners = new Set<() => void>();
  private initialization?: Promise<void>;
  private observationSession?: AbortController;
  private observationOwner?: symbol;
  private replica?: ObservationReplica;

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
    this.state = { ...this.state, ...change };
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
    if (this.state.config && this.state.transcriptId && !this.state.transcripts.get(this.state.transcriptId)?.syncing) {
      return (this.initialization = this.transcripts.watch(this.state.transcriptId).then(() => undefined));
    }
    return (this.initialization ??= this.loadInitial());
  }

  private async loadInitial(): Promise<void> {
    try {
      const [config, transcript] = await Promise.all([this.conversation.config(), this.transcripts.watch()]);
      const current = this.state.transcripts.get(transcript.id)?.snapshot ?? transcript;
      this.update({ config, transcriptId: current.id, messages: current.messages, error: undefined });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) this.update({ error });
      throw error;
    }
  }

  /** Load an entity only when needed, then keep its copy current until explicitly stopped. */
  loadTranscript(id: string): Promise<import('@capix-observer/protocol').TranscriptSnapshot> {
    return this.transcripts.watch(id);
  }

  stopTranscript(id?: string): void {
    this.transcripts.stop(id);
    if (!this.state.config && (!id || id === this.state.transcriptId)) this.initialization = undefined;
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
        this.updateObservation({ loading: false, overview: next.overview, memory: next.memory, records, updates: new Map(next.snapshots), cursor: { scopeId: next.scopeId, sequence: next.sequence }, invocations: next.invocations, transcriptRecords: next.transcriptRecords });
      }, session.signal)
      .catch((error) => {
        if (session.signal.aborted || this.observationOwner !== owner) return;
        // At most one automatic baseline retry. Other failures remain visible and can be refreshed explicitly.
        if (resync && sequenceFailure(error)) {
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

  getExecution(id: string): RuntimeSnapshot | undefined {
    return this.state.observation.records.get(id);
  }

  async loadExecution(id: string, signal?: AbortSignal): Promise<RuntimeSnapshot> {
    if (!this.observation) throw new Error('未接入观测能力。');
    const cached = this.getExecution(id);
    if (cached && cached.execution.status !== 'running') return cached;
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

  private receive(update: ConversationUpdate): void {
    if (update.type === 'error') throw new Error(update.error);
    if (update.type === 'started') {
      if (update.transcriptId && update.transcriptId !== this.state.transcriptId) throw new Error('处理来源与当前消息集合不一致。');
      this.update({ contextId: update.contextId });
    }
    if (update.type === 'answer') {
      if (update.transcriptId && update.transcriptId !== this.state.transcriptId) throw new Error('回答来源与当前消息集合不一致。');
      const present = this.state.messages[update.index];
      if (present && (present.role !== 'assistant' || present.content !== update.output.content)) throw new Error('回答与消息实体内容不一致。');
      this.update({ answered: true });
    }
  }

  async submit(request: ExecutionRequest, accepted?: () => void): Promise<void> {
    if (this.state.busy) throw new Error('当前请求仍在处理。');
    if (!this.state.config?.configured) throw new Error('请先完成客户端初始化与服务端模型配置。');
    const messages = request.messages.map((message) => ({ ...message }));
    this.update({ busy: true, contextId: '', answered: false, error: undefined, pending: messages.at(-1)?.content ?? '' });
    let wasAccepted = false;
    let requiredEnd = this.state.messages.length + messages.length;
    let delivered: Extract<ConversationUpdate, { type: 'answer' }> | undefined;
    const errors: unknown[] = [];
    try {
      await this.conversation.run(
        { ...request, messages },
        (update) => {
          if (update.type === 'started') requiredEnd = update.inputIndex + 1;
          if (update.type === 'answer') requiredEnd = update.index + 1;
          this.receive(update);
          if (update.type === 'answer') delivered = update;
        },
        () => {
          wasAccepted = true;
          this.update({ pending: '' });
          accepted?.();
        },
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      if (wasAccepted && (!this.state.transcriptId || !this.state.transcripts.get(this.state.transcriptId)?.syncing || this.state.messages.length < requiredEnd)) await this.transcripts.refresh(this.state.transcriptId);
      if (delivered) {
        const message = this.state.messages[delivered.index];
        if (!message || message.role !== 'assistant' || message.content !== delivered.output.content) throw new Error('回答与消息实体内容不一致。');
      }
    } catch (error) {
      errors.push(error);
    } finally {
      this.update({ busy: false, pending: '' });
    }
    // Observation consumes its own stream; submission does not trigger observation queries.

    const error = errors.length > 1 ? new AggregateError(errors, '请求处理与消息刷新均失败。', { cause: errors[0] }) : errors[0];
    if (error) {
      this.update({ error });
      throw error;
    }
  }
}

function sequenceFailure(error: unknown): boolean {
  return error instanceof ObservationSequenceError || (error instanceof Error && error.cause instanceof ObservationSequenceError);
}
