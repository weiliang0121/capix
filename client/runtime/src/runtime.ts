import type { ConfigurationResponse, ExecutionRequest, MemoryObservation, Message, ObserverOverview, RuntimeSnapshot } from '@capix-observer/protocol';
import { updateOverview } from './overview.js';
import type { ClientTransport } from './transport.js';

export interface ClientState {
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
  private state: ClientState = { overview: { messages: [], executions: [] }, messages: [], memory: { items: [] }, busy: false, pending: '', runningId: '' };
  private readonly listeners = new Set<() => void>();
  private readonly snapshots = new Map<string, RuntimeSnapshot>();
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
    const [overview, transcript, memory] = await Promise.all([this.transport.overview(), this.transport.transcript(), this.transport.memory()]);
    this.update({ overview, messages: transcript.messages, memory });
  }

  getExecution(id: string): RuntimeSnapshot | undefined {
    return this.snapshots.get(id);
  }

  async loadExecution(id: string, signal?: AbortSignal): Promise<RuntimeSnapshot> {
    const cached = this.snapshots.get(id);
    if (cached && cached.execution.status !== 'running') return cached;
    const snapshot = await this.transport.execution(id, signal);
    // A stream update received during this read is already newer than the cached observation.
    const current = this.snapshots.get(id);
    if (current && current !== cached) return current;
    this.snapshots.set(id, snapshot);
    this.update({});
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
    try {
      await this.transport.run(
        { ...request, messages },
        (snapshot) => {
          this.snapshots.set(snapshot.execution.id, snapshot);
          this.update({ runningId: snapshot.execution.id, overview: updateOverview(this.state.overview, snapshot) });
        },
        () => {
          wasAccepted = true;
          this.update({ messages: [...this.state.messages, ...messages], pending: '' });
          accepted?.();
        },
      );
    } finally {
      try {
        if (wasAccepted) await this.refresh();
      } finally {
        this.update({ busy: false, pending: '' });
      }
    }
  }
}
