import type { ConfigurationResponse, ConversationUpdate, ExecutionRequest, MemoryObservation, Message, ObserverOverview, RuntimeSnapshot } from '@capix-observer/protocol';
import type { ConversationTransport, ObservationTransport } from './transport.js';

export interface ObservationState {
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly error?: unknown;
  readonly records: ReadonlyMap<string, RuntimeSnapshot>;
  readonly updates: ReadonlyMap<string, RuntimeSnapshot>;
  readonly overview: ObserverOverview;
  readonly memory: MemoryObservation;
}

export interface ClientState {
  readonly config?: ConfigurationResponse;
  readonly messages: readonly Readonly<Message>[];
  readonly busy: boolean;
  readonly pending: string;
  readonly contextId: string;
  readonly answered: boolean;
  readonly error?: unknown;
  readonly observation: ObservationState;
}

export interface ClientRuntimeOptions {
  readonly conversation: ConversationTransport;
  readonly observation?: ObservationTransport;
}

/** Business delivery is independent of the optional observation capability. */
export class ClientRuntime {
  private state: ClientState = {
    messages: [],
    busy: false,
    pending: '',
    contextId: '',
    answered: false,
    observation: { enabled: false, loading: false, records: new Map(), updates: new Map(), overview: { messages: [], executions: [] }, memory: { items: [] } },
  };
  private readonly listeners = new Set<() => void>();
  private initialization?: Promise<void>;
  private observationSession?: AbortController;
  private observationRefresh = 0;

  private readonly conversation: ConversationTransport;
  private readonly observation?: ObservationTransport;

  constructor(options: ClientRuntimeOptions) {
    this.conversation = options.conversation;
    this.observation = options.observation;
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
    for (const listener of this.listeners) listener();
  }

  private updateObservation(change: Partial<ObservationState>) {
    this.update({ observation: { ...this.state.observation, ...change } });
  }

  initialize(): Promise<void> {
    return (this.initialization ??= this.loadInitial());
  }

  private async loadInitial(): Promise<void> {
    try {
      const [config, transcript] = await Promise.all([this.conversation.config(), this.conversation.transcript()]);
      this.update({ config, messages: transcript.messages, error: undefined });
    } catch (error) {
      this.update({ error });
      throw error;
    }
  }

  /** Explicitly enable live observation. Stopping it never cancels conversation work. */
  startObservation(): () => void {
    if (!this.observation) return () => {};
    this.observationSession?.abort();
    const session = new AbortController();
    this.observationSession = session;
    this.updateObservation({ enabled: true, error: undefined });
    void this.observation
      .observe((snapshot) => {
        if (session.signal.aborted) return;
        const current = this.state.observation;
        this.updateObservation({ records: new Map(current.records).set(snapshot.execution.id, snapshot), updates: new Map(current.updates).set(snapshot.execution.id, snapshot) });
        if (snapshot.execution.status !== 'running') void this.refreshObservation();
      }, session.signal)
      .catch((error) => {
        if (!session.signal.aborted) this.updateObservation({ error });
      });
    void this.refreshObservation();
    return () => {
      session.abort();
      if (this.observationSession !== session) return;
      this.observationSession = undefined;
      this.observationRefresh++;
      this.updateObservation({ enabled: false, loading: false });
    };
  }

  async refreshObservation(): Promise<void> {
    const session = this.observationSession;
    if (!this.observation || !session || session.signal.aborted) return;
    const refresh = ++this.observationRefresh;
    const pending = this.state.observation.updates;
    this.updateObservation({ loading: true });
    const [overview, memory] = await Promise.allSettled([this.observation.overview(), this.observation.memory()]);
    if (session.signal.aborted || refresh !== this.observationRefresh) return;
    let change: Partial<ObservationState> = { loading: false };
    const errors: unknown[] = [];
    if (overview.status === 'fulfilled') {
      change = { ...change, overview: overview.value };
      if (this.state.observation.updates === pending) change = { ...change, updates: new Map() };
    } else errors.push(overview.reason);
    if (memory.status === 'fulfilled') change = { ...change, memory: memory.value };
    else errors.push(memory.reason);
    // A successful query does not hide a disconnected observation stream.
    if (errors.length) change = { ...change, error: errors.length === 1 ? errors[0] : new AggregateError(errors, '观测刷新失败。') };
    this.updateObservation(change);
  }

  getExecution(id: string): RuntimeSnapshot | undefined {
    return this.state.observation.records.get(id);
  }

  async loadExecution(id: string, signal?: AbortSignal): Promise<RuntimeSnapshot> {
    if (!this.observation) throw new Error('未接入观测能力。');
    const cached = this.getExecution(id);
    if (cached && cached.execution.status !== 'running') return cached;
    const snapshot = await this.observation.execution(id, signal);
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
    if (update.type === 'started') this.update({ contextId: update.contextId });
    if (update.type === 'answer') {
      if (update.index !== this.state.messages.length) throw new Error('回答消息位置与当前对话不一致，需要重新加载消息。');
      this.update({ answered: true, messages: [...this.state.messages, { role: 'assistant', content: update.output.content }] });
    }
  }

  async submit(request: ExecutionRequest, accepted?: () => void): Promise<void> {
    if (this.state.busy) throw new Error('当前请求仍在处理。');
    if (!this.state.config?.configured) throw new Error('请先完成客户端初始化与服务端模型配置。');
    const messages = request.messages.map((message) => ({ ...message }));
    this.update({ busy: true, contextId: '', answered: false, error: undefined, pending: messages.at(-1)?.content ?? '' });
    let wasAccepted = false;
    const errors: unknown[] = [];
    try {
      await this.conversation.run(
        { ...request, messages },
        (update) => this.receive(update),
        () => {
          wasAccepted = true;
          this.update({ messages: [...this.state.messages, ...messages], pending: '' });
          accepted?.();
        },
      );
    } catch (error) {
      errors.push(error);
    }
    try {
      if (wasAccepted) {
        const transcript = await this.conversation.transcript();
        this.update({ messages: transcript.messages });
      }
    } catch (error) {
      errors.push(error);
    } finally {
      this.update({ busy: false, pending: '' });
    }
    // Observation refresh has its own failure channel and is never awaited by submission.
    if (wasAccepted) void this.refreshObservation();
    const error = errors.length > 1 ? new AggregateError(errors, '请求处理与消息刷新均失败。', { cause: errors[0] }) : errors[0];
    if (error) {
      this.update({ error });
      throw error;
    }
  }
}
