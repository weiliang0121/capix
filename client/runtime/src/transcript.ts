import type { TranscriptFrame, TranscriptSnapshot } from '@capix-observer/protocol';
import type { TranscriptTransport } from './transport.js';

export class TranscriptSequenceError extends Error {}

/** An entity replica: identity and revision are independent of observation delivery. */
export class TranscriptReplica {
  private constructor(readonly snapshot: TranscriptSnapshot) {}

  static receive(previous: TranscriptReplica | undefined, frame: TranscriptFrame, expectedId?: string): TranscriptReplica {
    if (frame.type === 'baseline') {
      const snapshot = frame.snapshot;
      if (expectedId && snapshot.id !== expectedId) throw new TranscriptSequenceError('返回了不同的消息集合。');
      if (!snapshot.id || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.start !== 0 || snapshot.end !== snapshot.messages.length || !snapshot.starts.length || snapshot.starts[0] !== 0 || snapshot.starts.some((start, index) => !Number.isSafeInteger(start) || start < 0 || (index > 0 && start <= snapshot.starts[index - 1]!) || (start > 0 && start >= snapshot.end))) throw new TranscriptSequenceError('消息基线范围无效。');
      return new TranscriptReplica(snapshot);
    }
    const event = frame.event;
    if (!previous || event.transcriptId !== previous.snapshot.id) throw new TranscriptSequenceError('消息集合不一致或缺少基线。');
    const before = previous.snapshot;
    if (event.revision <= before.revision) return previous;
    if (event.revision !== before.revision + 1) throw new TranscriptSequenceError('消息变化存在缺口，需要重新建立基线。');
    const change = event.change;
    if (change.kind === 'messages-appended') {
      if (change.start !== before.end || !change.messages.length) throw new TranscriptSequenceError('消息追加位置不一致。');
      return new TranscriptReplica({ ...before, revision: event.revision, end: before.end + change.messages.length, messages: [...before.messages, ...change.messages] });
    }
    if (change.previousStart !== before.starts.at(-1) || change.start <= change.previousStart || change.start >= change.end || change.end !== before.end) throw new TranscriptSequenceError('消息段边界不一致。');
    return new TranscriptReplica({ ...before, revision: event.revision, starts: [...before.starts, change.start] });
  }
}

export interface TranscriptState {
  readonly snapshot?: TranscriptSnapshot;
  readonly loading: boolean;
  readonly syncing: boolean;
  readonly error?: unknown;
}

interface TranscriptSession {
  readonly controller: AbortController;
  readonly ready: Promise<TranscriptSnapshot>;
  readonly resolve: (snapshot: TranscriptSnapshot) => void;
  id?: string;
}

/** One live subscription per entity. Restarting always obtains a fresh atomic baseline. */
export class TranscriptReceiver {
  private readonly sessions = new Map<string, TranscriptSession>();
  private readonly replicas = new Map<string, TranscriptReplica>();
  private states: ReadonlyMap<string, TranscriptState> = new Map();

  constructor(
    private readonly transport: TranscriptTransport,
    private readonly changed: (states: ReadonlyMap<string, TranscriptState>) => void,
  ) {}

  get defaultId(): string | undefined {
    return this.sessions.get('')?.id;
  }

  private publish(id: string, state: TranscriptState): void {
    this.states = new Map(this.states).set(id, state);
    this.changed(this.states);
  }

  watch(id?: string): Promise<TranscriptSnapshot> {
    const key = id ?? '';
    const existing = this.sessions.get(key) ?? [...this.sessions.values()].find((session) => id && session.id === id);
    if (existing) return existing.ready.then((snapshot) => this.replicas.get(snapshot.id)?.snapshot ?? snapshot);
    const controller = new AbortController();
    let resolveReady!: (snapshot: TranscriptSnapshot) => void;
    let rejectReady!: (error: unknown) => void;
    const ready = new Promise<TranscriptSnapshot>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const session: TranscriptSession = { controller, ready, resolve: resolveReady, id };
    this.sessions.set(key, session);
    if (id) this.publish(id, { snapshot: this.replicas.get(id)?.snapshot, loading: true, syncing: true });
    controller.signal.addEventListener('abort', () => rejectReady(new DOMException('消息同步已停止。', 'AbortError')), { once: true });
    const connect = async (retry: boolean): Promise<void> => {
      let received = false;
      let local: TranscriptReplica | undefined;
      try {
        await this.transport.observeTranscript(
          session.id,
          (frame) => {
            if (controller.signal.aborted || this.sessions.get(key) !== session) return;
            if ((!received && frame.type !== 'baseline') || (received && frame.type === 'baseline')) throw new TranscriptSequenceError('消息连接必须提供且仅提供一次初始基线。');
            const next = TranscriptReplica.receive(local, frame, session.id);
            local = next;
            received = true;
            session.id = next.snapshot.id;
            const previous = this.replicas.get(session.id);
            // An explicit query may have already advanced the same entity. Never regress its copy.
            if (!previous || next.snapshot.revision >= previous.snapshot.revision) {
              this.replicas.set(session.id, next);
              this.publish(session.id, { snapshot: next.snapshot, loading: false, syncing: true });
            }
            // Publication may stop this stream and synchronously establish its replacement.
            if (controller.signal.aborted || this.sessions.get(key) !== session) return;
            const current = this.replicas.get(session.id)!.snapshot;
            // A default subscription and an explicit UID can start before either baseline arrives.
            // Once the default identity is known, keep one stream without rejecting its callers.
            for (const [otherKey, other] of this.sessions) {
              if (other === session || other.id !== session.id) continue;
              this.sessions.delete(otherKey);
              other.resolve(current);
              other.controller.abort();
            }
            resolveReady(current);
          },
          controller.signal,
        );
        if (!controller.signal.aborted) throw new TranscriptSequenceError('消息同步连接已结束。');
      } catch (error) {
        if (controller.signal.aborted || this.sessions.get(key) !== session) return;
        if (retry && resynchronizable(error)) {
          await connect(false);
          return;
        }
        this.sessions.delete(key);
        if (session.id) this.publish(session.id, { snapshot: this.replicas.get(session.id)?.snapshot, loading: false, syncing: false, error });
        rejectReady(error);
      }
    };
    void connect(true);
    return ready;
  }

  async refresh(id?: string, signal?: AbortSignal): Promise<TranscriptSnapshot> {
    const snapshot = await this.transport.transcript(id, signal);
    const next = TranscriptReplica.receive(undefined, { type: 'baseline', snapshot }, id);
    const previous = this.replicas.get(snapshot.id);
    if (previous && previous.snapshot.revision > snapshot.revision) return previous.snapshot;
    this.replicas.set(snapshot.id, next);
    const syncing = [...this.sessions.values()].some((session) => session.id === snapshot.id);
    this.publish(snapshot.id, { snapshot, loading: false, syncing });
    return snapshot;
  }

  stop(id?: string): void {
    for (const [key, session] of this.sessions) {
      if (id && session.id !== id) continue;
      this.sessions.delete(key);
      session.controller.abort();
      if (session.id) this.publish(session.id, { snapshot: this.replicas.get(session.id)?.snapshot, loading: false, syncing: false });
    }
  }
}

function resynchronizable(error: unknown): boolean {
  if (error instanceof TranscriptSequenceError || error instanceof TypeError) return true;
  if (!(error instanceof Error)) return false;
  if ('code' in error && error.code === 'INCOMPLETE_STREAM') return true;
  return error.cause instanceof TranscriptSequenceError;
}
