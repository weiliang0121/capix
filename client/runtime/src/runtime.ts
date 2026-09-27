import type { ConfigurationResponse, ExecutionRequest, MemoryObservation, Message, ObserverOverview, RuntimeSnapshot } from '@capix-observer/protocol';
import type { ClientTransport } from './transport.js';

export interface ClientState {
  /** Received records, including on-demand reads; no application projection. */
  readonly records: ReadonlyMap<string, RuntimeSnapshot>;
  /** Stream observations not yet reconciled by a successful overview/transcript refresh. */
  readonly updates: ReadonlyMap<string, RuntimeSnapshot>;
  readonly config?: ConfigurationResponse;
  readonly overview: ObserverOverview;
  readonly messages: readonly Readonly<Message>[];
  readonly memory: MemoryObservation;
  readonly busy: boolean;
  readonly pending: string;
  readonly runningId: string;
}

/** Owns one client's submission and observed server state; presentation stays with the consumer. */
export class ClientRuntime {
  private state: ClientState = { records: new Map(), updates: new Map(), overview: { messages: [], executions: [] }, messages: [], memory: { items: [] }, busy: false, pending: '', runningId: '' };
  private readonly listeners = new Set<() => void>();
  private initialization?: Promise<void>;

  constructor(private readonly transport: ClientTransport) {}

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

  initialize(): Promise<void> {
    return (this.initialization ??= this.loadInitial());
  }

  private async loadInitial(): Promise<void> {
    const [config, overview, transcript, memory] = await Promise.all([this.transport.config(), this.transport.overview(), this.transport.transcript(), this.transport.memory()]);
    this.update({ config, overview, messages: transcript.messages, memory });
  }

  private async refresh(): Promise<void> {
    // Message indexes and their execution associations reconcile together.
    // Memory refresh failure must not discard a successfully reconciled conversation.
    const [conversation, memory] = await Promise.allSettled([Promise.all([this.transport.overview(), this.transport.transcript()]), this.transport.memory()]);
    let change: Partial<ClientState> = {};
    const errors: unknown[] = [];
    if (conversation.status === 'fulfilled') {
      const [overview, transcript] = conversation.value;
      change = { overview, messages: transcript.messages, updates: new Map() };
    } else errors.push(conversation.reason);
    if (memory.status === 'fulfilled') change = { ...change, memory: memory.value };
    else errors.push(memory.reason);
    this.update(change);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '对话与记忆刷新均失败。');
  }

  getExecution(id: string): RuntimeSnapshot | undefined {
    return this.state.records.get(id);
  }

  async loadExecution(id: string, signal?: AbortSignal): Promise<RuntimeSnapshot> {
    const cached = this.state.records.get(id);
    if (cached && cached.execution.status !== 'running') return cached;
    const snapshot = await this.transport.execution(id, signal);
    // A stream update received during this read is already newer than the cached observation.
    const current = this.state.records.get(id);
    if (current && current !== cached) return current;
    this.update({ records: new Map(this.state.records).set(id, snapshot) });
    return snapshot;
  }

  source(path: string, signal?: AbortSignal) {
    return this.transport.source(path, signal);
  }

  async submit(request: ExecutionRequest, accepted?: () => void): Promise<void> {
    if (this.state.busy) throw new Error('当前请求仍在处理。');
    if (!this.state.config?.configured) throw new Error('请先完成客户端初始化与服务端模型配置。');
    const messages = request.messages.map((message) => ({ ...message }));
    this.update({ busy: true, runningId: '', pending: messages.at(-1)?.content ?? '' });
    let wasAccepted = false;
    const errors: unknown[] = [];
    try {
      await this.transport.run(
        { ...request, messages },
        (snapshot) => {
          this.update({ runningId: snapshot.execution.id, records: new Map(this.state.records).set(snapshot.execution.id, snapshot), updates: new Map(this.state.updates).set(snapshot.execution.id, snapshot) });
        },
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
      if (wasAccepted) await this.refresh();
    } catch (error) {
      errors.push(error);
    } finally {
      this.update({ busy: false, pending: '' });
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '请求处理与结束刷新均失败。', { cause: errors[0] });
  }
}
