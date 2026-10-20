import type { ExecutionRecordSnapshot, InvocationEvent, MemoryObservation, ObserverOverview, SourceResponse, TranscriptRecord } from '@capix/protocol';
import { ObservationConnectionError, type ObservationTransport } from '../transport.js';
import { ObservationReplica, ObservationSequenceError, ObservationContractError } from './replica.js';

export interface ObservationState {
  readonly enabled: boolean;
  readonly loading: boolean;
  readonly reconnectable: boolean;
  readonly error?: unknown;
  readonly records: ReadonlyMap<string, ExecutionRecordSnapshot>;
  readonly updates: ReadonlyMap<string, ExecutionRecordSnapshot>;
  readonly overview: ObserverOverview;
  readonly memory: MemoryObservation;
  readonly cursor?: { scopeId: string; sequence: number };
  readonly invocationEvents?: ReadonlyMap<string, InvocationEvent>;
  readonly transcriptRecords?: readonly TranscriptRecord[];
}

/** Owns optional observation delivery and its accepted cache; publication belongs to the client. */
export class ObservationReceiver {
  private state: ObservationState = Object.freeze({ enabled: false, loading: false, reconnectable: false, records: new Map(), updates: new Map(), overview: { transcriptId: '', messages: [], executions: [] }, memory: { items: [] } });
  private owner?: symbol;
  private session?: AbortController;
  private generation = 0;
  private replica?: ObservationReplica;
  private conversationId?: string;
  private transcriptId?: string;
  private terminal = false;

  constructor(
    private readonly transport: ObservationTransport | undefined,
    private readonly changed: (state: ObservationState) => void,
  ) {}

  get snapshot(): ObservationState {
    return this.state;
  }

  private update(change: Partial<ObservationState>): void {
    this.state = Object.freeze({ ...this.state, ...change });
    this.changed(this.state);
  }

  setConversation(conversationId: string, transcriptId: string): void {
    if (this.conversationId === conversationId && this.transcriptId === transcriptId) return;
    const previous = this.session;
    this.session = undefined;
    this.conversationId = conversationId;
    this.transcriptId = transcriptId;
    const generation = ++this.generation;
    this.replica = undefined;
    this.terminal = false;
    this.state = Object.freeze({ enabled: !!this.owner, loading: false, reconnectable: false, records: new Map(), updates: new Map(), overview: { transcriptId, messages: [], executions: [] }, memory: { items: [] } });
    this.changed(this.state);
    previous?.abort();
    if (this.generation === generation && this.owner) this.connect(this.owner, true);
  }

  /** Starting a new owner supersedes the previous one; old stop handles cannot stop it. */
  start(): () => void {
    if (!this.transport) return () => {};
    const owner = Symbol('observation');
    this.owner = owner;
    if (this.terminal) this.update({ enabled: true });
    else this.connect(owner, true);
    return () => {
      if (this.owner !== owner) return;
      const session = this.session;
      this.owner = undefined;
      this.session = undefined;
      this.generation++;
      this.update({ enabled: false, loading: false });
      session?.abort();
    };
  }

  refresh(): void {
    if (this.owner && !this.terminal) this.connect(this.owner, false);
  }

  private connect(owner: symbol, resync: boolean): void {
    if (!this.transport || !this.conversationId) return;
    const previous = this.session;
    const session = new AbortController();
    this.session = session;
    this.generation++;
    this.update({ enabled: true, loading: true, reconnectable: false, error: undefined });
    previous?.abort();
    void this.consume(owner, session, resync);
  }

  private async consume(owner: symbol, session: AbortController, resync: boolean): Promise<void> {
    const current = () => this.owner === owner && this.session === session && !session.signal.aborted;
    if (!current() || !this.transport || !this.conversationId) return;
    let ready = false;
    try {
      await this.transport.observe(
        this.conversationId,
        (frame) => {
          if (!current()) return;
          if (frame.type === 'baseline' && frame.transcript.id !== this.transcriptId) throw new ObservationContractError('观测不属于当前对话的消息集合。');
          if (!ready && frame.type !== 'baseline') throw new ObservationSequenceError('观测连接缺少初始基线。');
          if (ready && frame.type === 'baseline') throw new ObservationContractError('同一连接重复提供基线。');
          const next = ObservationReplica.receive(ready ? this.replica : undefined, frame);
          if (next === this.replica) return;
          this.replica = next;
          ready = true;
          const records = frame.type === 'baseline' ? next.snapshots : next.updates.size ? new Map([...this.state.records, ...next.updates]) : this.state.records;
          const updates = frame.type === 'baseline' ? next.snapshots : next.updates.size ? new Map([...this.state.updates, ...next.updates]) : this.state.updates;
          this.update({ loading: false, overview: next.overview, memory: next.memory, records, updates, cursor: { scopeId: next.scopeId, sequence: next.sequence }, invocationEvents: next.invocationEvents, transcriptRecords: next.transcriptRecords });
        },
        session.signal,
      );
      if (current()) throw new ObservationConnectionError('观测连接已结束。');
    } catch (error) {
      if (!current()) return;
      // A missing delivery can rebuild its baseline once; incomplete source facts cannot be repaired here.
      if (resync && !sourceIncomplete(error) && sequenceFailure(error)) {
        this.connect(owner, false);
        return;
      }
      const reconnectable = !sourceIncomplete(error) && error instanceof ObservationConnectionError;
      this.terminal = !reconnectable;
      this.update({ loading: false, reconnectable, error });
      session.abort();
    }
  }

  getExecution(id: string): ExecutionRecordSnapshot | undefined {
    return this.state.records.get(id);
  }

  async loadExecution(id: string, signal?: AbortSignal): Promise<ExecutionRecordSnapshot> {
    if (!this.transport || !this.conversationId) throw new Error('未接入观测能力或尚未打开对话。');
    const cached = this.getExecution(id);
    if (cached && (cached.archive || (cached.execution.status !== 'running' && cached.rootCall?.status !== 'running' && (cached.ancestors ?? []).every((call) => call.status !== 'running')))) return cached;
    const generation = this.generation;
    const snapshot = await this.transport.execution(this.conversationId, id, signal);
    if (generation !== this.generation) throw new Error('观测连接已更换，忽略旧详情响应。');
    const current = this.getExecution(id);
    if (current && current !== cached) return current;
    this.update({ records: new Map(this.state.records).set(id, snapshot) });
    return snapshot;
  }

  source(path: string, signal?: AbortSignal): Promise<SourceResponse> {
    if (!this.transport) return Promise.reject(new Error('未接入观测能力。'));
    return this.transport.source(path, signal);
  }
}

function sequenceFailure(error: unknown): boolean {
  const candidate = error instanceof Error && error.cause instanceof ObservationSequenceError ? error.cause : error;
  return candidate instanceof ObservationSequenceError && !(candidate instanceof ObservationContractError);
}

function sourceIncomplete(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'SOURCE_INCOMPLETE';
}
