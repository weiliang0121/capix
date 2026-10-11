import type { TranscriptFrame, TranscriptSnapshot } from '@capix/protocol';
import { TranscriptConnectionError, type TranscriptTransport } from './transport.js';

export class TranscriptSequenceError extends Error {
  constructor(
    message: string,
    readonly recoverable = false,
  ) {
    super(message);
  }
}

/** An entity replica: identity and revision are independent of observation delivery. */
export class TranscriptReplica {
  private constructor(readonly snapshot: TranscriptSnapshot) {}

  static receive(previous: TranscriptReplica | undefined, frame: TranscriptFrame, expectedId?: string): TranscriptReplica {
    if (frame.type === 'baseline') {
      const snapshot = frame.snapshot;
      if (expectedId && snapshot.id !== expectedId) throw new TranscriptSequenceError('返回了不同的消息集合。');
      if (!snapshot.id || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || snapshot.start !== 0 || snapshot.end !== snapshot.messages.length || !snapshot.starts.length || snapshot.starts[0] !== 0 || snapshot.starts.some((start, index) => !Number.isSafeInteger(start) || start < 0 || (index > 0 && start <= snapshot.starts[index - 1]!) || (start > 0 && start >= snapshot.end))) throw new TranscriptSequenceError('消息基线范围无效。');
      if (previous) {
        const before = previous.snapshot;
        if (snapshot.id !== before.id) throw new TranscriptSequenceError('消息集合身份发生变化。');
        if (snapshot.messages.slice(0, before.end).some((message, index) => message.role !== before.messages[index]?.role || message.content !== before.messages[index]?.content) || snapshot.starts.slice(0, before.starts.length).some((start, index) => start !== before.starts[index])) throw new TranscriptSequenceError('消息基线与已接纳内容冲突。');
        if ((snapshot.revision >= before.revision && (snapshot.end < before.end || snapshot.starts.length < before.starts.length)) || (snapshot.revision <= before.revision && (snapshot.end > before.end || snapshot.starts.length > before.starts.length))) throw new TranscriptSequenceError('消息基线的范围与修订不一致。');
        if (snapshot.revision <= before.revision) return previous;
      }
      return new TranscriptReplica(Object.freeze({ ...snapshot, starts: Object.freeze([...snapshot.starts]), messages: Object.freeze(snapshot.messages.map((message) => Object.freeze({ ...message }))) }));
    }
    const event = frame.event;
    if (!previous || event.transcriptId !== previous.snapshot.id) throw new TranscriptSequenceError('消息集合不一致或缺少基线。');
    const before = previous.snapshot;
    if (event.revision <= before.revision) return previous;
    if (event.revision !== before.revision + 1) throw new TranscriptSequenceError('消息变化存在缺口，需要重新建立基线。', true);
    const change = event.change;
    if (change.kind === 'messages-appended') {
      if (change.start !== before.end || !change.messages.length) throw new TranscriptSequenceError('消息追加位置不一致。');
      return new TranscriptReplica(Object.freeze({ ...before, revision: event.revision, end: before.end + change.messages.length, messages: Object.freeze([...before.messages, ...change.messages.map((message) => Object.freeze({ ...message }))]) }));
    }
    if (change.previousStart !== before.starts.at(-1) || change.start <= change.previousStart || change.start >= change.end || change.end !== before.end) throw new TranscriptSequenceError('消息段边界不一致。');
    return new TranscriptReplica(Object.freeze({ ...before, revision: event.revision, starts: Object.freeze([...before.starts, change.start]) }));
  }
}

export type TranscriptSyncState = { readonly status: 'connecting'; readonly attempt: number } | { readonly status: 'live' } | { readonly status: 'retrying'; readonly attempt: number; readonly retryAt: number; readonly error: unknown } | { readonly status: 'failed'; readonly error: unknown } | { readonly status: 'stopped' };

export interface TranscriptState {
  readonly snapshot?: TranscriptSnapshot;
  readonly sync: TranscriptSyncState;
}

interface TranscriptReady {
  readonly promise: Promise<TranscriptSnapshot>;
  readonly resolve: (snapshot: TranscriptSnapshot) => void;
  readonly reject: (error: unknown) => void;
}

interface TranscriptSession {
  readonly key: string;
  id?: string;
  ready?: TranscriptReady;
  controller?: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  retries: number;
  sync: TranscriptSyncState;
}

const retryDelays = [500, 1500, 4000] as const;
const stableConnectionMs = 30_000;

/** Owns one desired subscription per entity, including its bounded reconnection lifecycle. */
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

  private publish(session: TranscriptSession): void {
    if (!session.id) return;
    this.states = new Map(this.states).set(session.id, Object.freeze({ snapshot: this.replicas.get(session.id)?.snapshot, sync: Object.freeze(session.sync) }));
    this.changed(this.states);
  }

  private pending(session: TranscriptSession): TranscriptReady {
    if (session.ready) return session.ready;
    let resolve!: TranscriptReady['resolve'];
    let reject!: TranscriptReady['reject'];
    const promise = new Promise<TranscriptSnapshot>((success, failure) => {
      resolve = success;
      reject = failure;
    });
    // A background reconnect can fail without a caller currently awaiting readiness.
    void promise.catch(() => undefined);
    session.ready = { promise, resolve, reject };
    return session.ready;
  }

  watch(id?: string): Promise<TranscriptSnapshot> {
    const key = id ?? '';
    const existing = this.sessions.get(key) ?? [...this.sessions.values()].find((session) => id && session.id === id);
    if (existing) {
      if (existing.sync.status === 'live' && existing.id) return Promise.resolve(this.replicas.get(existing.id)!.snapshot);
      return this.pending(existing).promise;
    }
    const session: TranscriptSession = { key, id, retries: 0, sync: { status: 'connecting', attempt: 0 } };
    this.sessions.set(key, session);
    const ready = this.pending(session).promise;
    void this.connect(session);
    return ready;
  }

  private async connect(session: TranscriptSession): Promise<void> {
    if (this.sessions.get(session.key) !== session) return;
    const controller = new AbortController();
    session.controller = controller;
    session.timer = undefined;
    session.sync = { status: 'connecting', attempt: session.retries };
    this.publish(session);
    const current = () => this.sessions.get(session.key) === session && session.controller === controller && !controller.signal.aborted;
    if (!current()) return;
    let local: TranscriptReplica | undefined;
    let liveSince: number | undefined;
    let receptionError: unknown;
    let receptionFailed = false;
    try {
      await this.transport.observeTranscript(
        session.id,
        (frame) => {
          if (!current()) return;
          try {
            if ((!local && frame.type !== 'baseline') || (local && frame.type === 'baseline')) throw new TranscriptSequenceError('消息连接必须提供且仅提供一次初始基线。');
            const next = TranscriptReplica.receive(local, frame, session.id);
            const previous = this.replicas.get(next.snapshot.id);
            const accepted = frame.type === 'baseline' ? TranscriptReplica.receive(previous, frame, session.id) : this.acceptDelta(previous, next, frame);
            local = next;
            session.id = next.snapshot.id;
            this.replicas.set(session.id, accepted);
            if (liveSince === undefined) liveSince = Date.now();
            session.sync = { status: 'live' };
            this.publish(session);
            if (!current()) return;
            // Default and explicit UID requests can discover that they share one entity.
            for (const other of [...this.sessions.values()]) {
              if (other === session || other.id !== session.id) continue;
              this.sessions.delete(other.key);
              clearTimeout(other.timer);
              const old = other.controller;
              other.controller = undefined;
              other.ready?.resolve(accepted.snapshot);
              old?.abort();
              if (!current()) return;
            }
            const ready = session.ready;
            session.ready = undefined;
            ready?.resolve(accepted.snapshot);
          } catch (error) {
            receptionFailed = true;
            receptionError = error;
            throw error;
          }
        },
        controller.signal,
      );
      if (current()) throw new TranscriptConnectionError('消息同步连接已结束。');
    } catch (caught) {
      if (!current()) return;
      const error = receptionFailed ? receptionError : caught;
      if (liveSince !== undefined && Date.now() - liveSince >= stableConnectionMs) session.retries = 0;
      const recoverable = error instanceof TranscriptSequenceError ? error.recoverable : !receptionFailed && error instanceof TranscriptConnectionError;
      const delay = retryDelays[session.retries];
      if (recoverable && delay !== undefined) {
        session.retries++;
        this.pending(session);
        session.controller = undefined;
        session.sync = { status: 'retrying', attempt: session.retries, retryAt: Date.now() + delay, error };
        session.timer = setTimeout(() => void this.connect(session), delay);
        this.publish(session);
        controller.abort();
        return;
      }
      this.sessions.delete(session.key);
      session.controller = undefined;
      session.sync = { status: 'failed', error };
      session.ready?.reject(error);
      session.ready = undefined;
      this.publish(session);
      controller.abort();
    }
  }

  /** A lagging stream can catch up, but cannot rewrite a prefix obtained by another read. */
  private acceptDelta(previous: TranscriptReplica | undefined, next: TranscriptReplica, frame: Extract<TranscriptFrame, { type: 'delta' }>): TranscriptReplica {
    if (!previous || next.snapshot.revision > previous.snapshot.revision) return next;
    const change = frame.event.change;
    if (change.kind === 'messages-appended') {
      if (change.messages.some((message, index) => message.role !== previous.snapshot.messages[change.start + index]?.role || message.content !== previous.snapshot.messages[change.start + index]?.content)) throw new TranscriptSequenceError('重复消息变化与已接纳正文冲突。');
    } else if (!previous.snapshot.starts.includes(change.start)) throw new TranscriptSequenceError('重复分段变化与已接纳范围冲突。');
    if (next.snapshot.revision === previous.snapshot.revision && (next.snapshot.end !== previous.snapshot.end || next.snapshot.starts.length !== previous.snapshot.starts.length)) throw new TranscriptSequenceError('相同修订对应的消息范围不一致。');
    return previous;
  }

  async refresh(id?: string, signal?: AbortSignal): Promise<TranscriptSnapshot> {
    const snapshot = await this.transport.transcript(id, signal);
    const next = TranscriptReplica.receive(this.replicas.get(snapshot.id), { type: 'baseline', snapshot }, id);
    this.replicas.set(snapshot.id, next);
    const sync = this.states.get(snapshot.id)?.sync ?? { status: 'stopped' as const };
    this.states = new Map(this.states).set(snapshot.id, Object.freeze({ snapshot: next.snapshot, sync }));
    this.changed(this.states);
    return next.snapshot;
  }

  stop(id?: string): void {
    for (const session of [...this.sessions.values()]) {
      if (this.sessions.get(session.key) !== session) continue;
      if (id && session.id !== id) continue;
      this.sessions.delete(session.key);
      clearTimeout(session.timer);
      const controller = session.controller;
      session.controller = undefined;
      session.sync = { status: 'stopped' };
      session.ready?.reject(new DOMException('消息同步已停止。', 'AbortError'));
      session.ready = undefined;
      this.publish(session);
      controller?.abort();
    }
  }
}
