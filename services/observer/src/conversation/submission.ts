import type { ConversationAdmission, ConversationFailure, ConversationSubmissionSnapshot, ConversationSubmissionFrame, ConversationSubmissionBaseline, ConversationSubmissionChange, ConversationSubmissionUpdate, ConversationActivity, AnswerPreviewChange } from '@capix/protocol';
import { RuntimeError } from '@capix/contracts';
import { ProgressChannel } from '@capix/changes';
import { isInvocationCancelled, type InvocationProgress } from '@capix/server-runtime';
import { ConversationInputError } from './accept.js';
import type { ConversationProgress } from './progress.js';
import { ConversationActivityProjection } from './activity.js';
import { ConversationFileProjection } from './files.js';
import { ConversationPreviewProjection } from './preview.js';
import type { AnswerProgress } from './group/answer/stream.js';
import type { FileProgress } from '../files/index.js';

export function conversationFailure(error: unknown): ConversationFailure {
  return Object.freeze(error instanceof RuntimeError ? { code: error.code, message: error.message } : { code: 'INTERNAL_ERROR', message: '服务内部错误。' });
}

/** One service request outlives individual connections. It neither owns messages nor schedules work. */
export class ConversationSubmission {
  private state: Omit<ConversationSubmissionSnapshot, 'activities'>;
  private current?: ConversationSubmissionSnapshot;
  private readonly listeners = new Set<(snapshot: ConversationSubmissionSnapshot) => void>();
  private readonly frameListeners = new Map<(frame: ConversationSubmissionFrame) => void, number>();
  private pendingFromRevision?: number;
  private pendingChange: ConversationSubmissionChange = {};
  private readonly pendingCalls = new Map<string, ConversationActivity>();
  private pendingPreview: AnswerPreviewChange[] = [];
  private rebaseline = false;
  private readonly preview = new ConversationPreviewProjection((change) => {
    if (!this.rebaseline) {
      this.pendingPreview.push(change);
      if (this.pendingPreview.length > 512) {
        this.pendingPreview = [];
        this.rebaseline = true;
      }
    }
    this.notify();
  });
  readonly answerProgress = new ProgressChannel<AnswerProgress>({
    receive: (fact): undefined => {
      if (this.completedAt !== undefined) throw new Error('Answer output arrived after completion');
      this.preview.receive(fact);
    },
    failed: (): undefined => {
      this.preview.finish('failed');
    },
  });
  private readonly controller = new AbortController();
  private notifying = false;
  private started = false;
  private completedAt: number | undefined;
  private task: Promise<void> | undefined;
  private readonly activities = new ConversationActivityProjection((activities) => this.update({ activities }));
  private readonly files = new ConversationFileProjection((fileOutput) => this.update({ fileOutput }));
  readonly fileProgress = new ProgressChannel<FileProgress>({
    receive: (fact): undefined => {
      if (this.completedAt !== undefined) throw new Error('File progress arrived after service completion');
      const task = this.state.task;
      if (!this.state.input || task?.kind !== 'file' || !task.task.output) throw new Error('File progress requires an accepted input and selected output task');
      const path = fact.kind === 'created' ? fact.receipt.path : fact.path;
      if (path !== task.task.output.path) throw new Error('File progress does not belong to the selected output path');
      this.files.receive(fact);
    },
    failed: (error): undefined => {
      this.files.invalidate();
      // Independent delivery failures must not expose a receipt without its accepted scope.
      // Once the task is known, file uncertainty can stay local to that output projection.
      if (!this.state.input || this.state.task?.kind !== 'file' || !this.state.task.task.output) this.invalidate(error);
    },
  });
  readonly activity = new ProgressChannel<InvocationProgress>({
    receive: (fact): undefined => {
      if (this.completedAt !== undefined) throw new Error('Activity arrived after service completion');
      this.activities.receive(fact);
    },
    failed: (error): undefined => this.activities.invalidate(error),
  });
  readonly progress = new ProgressChannel<ConversationProgress>({
    receive: (fact): undefined => this.receive(fact),
    failed: (error): undefined => this.invalidate(error),
  });

  constructor(
    readonly id: string,
    readonly conversationId: string,
    private readonly options: { admission?: () => ConversationAdmission } = {},
  ) {
    this.state = Object.freeze({ conversationId, submissionId: id, revision: 0, executions: Object.freeze([]), integrity: Object.freeze({ status: 'complete' }) });
  }

  get snapshot(): ConversationSubmissionSnapshot {
    return (this.current ??= Object.freeze({ ...this.state, activities: this.activities.snapshot }));
  }

  get baseline(): ConversationSubmissionBaseline {
    return Object.freeze({ type: 'baseline', submission: this.snapshot, ...(this.preview.snapshot ? { preview: this.preview.snapshot } : {}) });
  }

  get endedAt(): number | undefined {
    return this.completedAt;
  }

  /** Always consumes task rejection. Delivery callers only read the resulting service facts. */
  start(work: (signal: AbortSignal) => Promise<unknown>): void {
    if (this.started || this.completedAt !== undefined) throw new Error('Submission has already started or ended');
    this.started = true;
    this.task = this.run(work);
  }

  /** Request cooperative cancellation without ending delivery or inventing a work result. */
  requestCancellation(): ConversationSubmissionSnapshot {
    if (this.state.result || this.state.cancelRequested) return this.snapshot;
    this.update({ cancelRequested: true });
    this.controller.abort(new Error('Conversation cancellation requested'));
    return this.snapshot;
  }

  /** Only service checks performed before runtime entry may produce this explicit refusal. */
  reject(error: unknown, options: { retry?: 'admission' } = {}): void {
    if (this.started || this.completedAt !== undefined || this.state.revision !== 0) throw new Error('Cannot reject a submission after processing or progress');
    this.completedAt = Date.now();
    this.update({ result: Object.freeze({ status: 'rejected', error: conversationFailure(error), ...options }) });
  }

  private async run(work: (signal: AbortSignal) => Promise<unknown>): Promise<void> {
    let result: NonNullable<ConversationSubmissionSnapshot['result']>;
    try {
      await work(this.controller.signal);
      result = Object.freeze({ status: 'completed' });
    } catch (error) {
      if (isInvocationCancelled(error, this.controller.signal)) result = Object.freeze({ status: 'cancelled' });
      else {
        const rejected = this.state.integrity.status === 'complete' && !this.state.input && !this.state.task && !this.state.fileOutput && (error instanceof ConversationInputError || (error instanceof RuntimeError && error.code === 'RUNTIME_BUSY'));
        result = Object.freeze(rejected ? { status: 'rejected', error: conversationFailure(error), ...(error instanceof RuntimeError && error.code === 'RUNTIME_BUSY' ? { retry: 'admission' as const } : {}) } : { status: 'failed', error: conversationFailure(error) });
      }
    }
    this.preview.finish(result.status === 'cancelled' ? 'cancelled' : 'failed');
    this.files.finish();
    this.completedAt = Date.now();
    this.update({ result });
  }

  private receive(fact: ConversationProgress): undefined {
    if (this.state.integrity.status === 'incomplete') return;
    if (this.completedAt !== undefined) throw new Error('Progress arrived after service completion');
    if (fact.kind === 'task') {
      if (!this.state.input || this.state.task) throw new Error('Task selection requires a committed input and may only occur once');
      const task = fact.task.kind === 'file' ? Object.freeze({ kind: 'file' as const, task: Object.freeze({ ...fact.task.task, ...(fact.task.task.output ? { output: Object.freeze({ ...fact.task.task.output }) } : {}) }) }) : Object.freeze({ kind: fact.task.kind });
      this.update({ task });
      return;
    }
    if (fact.kind === 'execution') {
      if (this.state.executions.some((item) => item.contextId === fact.contextId)) return;
      this.update({ executions: Object.freeze([Object.freeze({ contextId: fact.contextId })]) });
      return;
    }
    if (fact.range.end <= fact.range.start) throw new Error('Committed message range must not be empty');
    if (fact.kind === 'input') {
      if (this.state.input) throw new Error('Conversation submission received more than one input commit');
      this.update({ input: Object.freeze({ ...fact.range }) });
      return;
    }
    if (!this.state.input || this.state.input.transcriptId !== fact.range.transcriptId || this.state.input.end > fact.range.start || fact.range.end !== fact.range.start + 1 || this.state.answer) throw new Error('Answer commit does not match the submitted input');
    this.update({ answer: Object.freeze({ transcriptId: fact.range.transcriptId, index: fact.range.start }) });
  }

  private invalidate(_error: unknown): undefined {
    if (this.state.integrity.status === 'incomplete') return;
    this.update({ integrity: Object.freeze({ status: 'incomplete', error: Object.freeze({ code: 'SUBMISSION_INCOMPLETE', message: '本次提交的进展解释不完整；运行可能仍在继续。' }) }) });
  }

  private update(change: ConversationSubmissionChange): void {
    const { activities, executions, admission: _admission, ...fields } = change;
    const next = { ...this.state, ...fields, revision: this.state.revision + 1, ...(executions ? { executions: Object.freeze([...this.state.executions, ...executions]) } : {}) };
    delete next.admission;
    try {
      if (this.options.admission) next.admission = this.options.admission();
    } catch {
      // An optional current-condition hint cannot invalidate committed progress or retain stale advice.
    }
    this.pendingFromRevision ??= this.state.revision;
    this.pendingChange = {
      ...this.pendingChange,
      ...fields,
      admission: next.admission ?? null,
      ...(executions ? { executions: [...(this.pendingChange.executions ?? []), ...executions] } : {}),
      ...(activities?.integrity ? { activities: { integrity: activities.integrity } } : {}),
    };
    for (const call of activities?.calls ?? []) this.pendingCalls.set(call.contextId, call);
    this.state = Object.freeze(next);
    this.current = undefined;
    this.notify();
  }

  private notify(): void {
    if (this.notifying) return;
    this.notifying = true;
    // Connection work never runs inside the producer's progress callback.
    queueMicrotask(() => {
      this.notifying = false;
      const changes = this.pendingPreview;
      const baseline = this.rebaseline;
      const fromRevision = this.pendingFromRevision;
      const change = this.pendingChange;
      const calls = Object.freeze([...this.pendingCalls.values()]);
      const revision = this.state.revision;
      this.pendingPreview = [];
      this.rebaseline = false;
      this.pendingFromRevision = undefined;
      this.pendingChange = {};
      this.pendingCalls.clear();
      const update: ConversationSubmissionUpdate | undefined = fromRevision === undefined ? undefined : Object.freeze({ type: 'submission', conversationId: this.conversationId, submissionId: this.id, fromRevision, revision, change: Object.freeze({ ...change, ...(calls.length || change.activities ? { activities: Object.freeze({ ...change.activities, ...(calls.length ? { calls } : {}) }) } : {}), ...(change.executions ? { executions: Object.freeze(change.executions) } : {}) }) });
      // Baselines alone need the cumulative graph and complete preview. Normal changes
      // keep their producer-supplied fields, so a text chunk never serializes that graph.
      const current = baseline ? this.baseline : undefined;
      for (const listener of [...this.frameListeners.keys()]) {
        if (current) this.deliverFrame(listener, current);
        else {
          for (const change of changes) this.deliverFrame(listener, { type: 'answer', conversationId: this.conversationId, submissionId: this.id, change });
          if (update && update.revision > (this.frameListeners.get(listener) ?? Infinity)) this.deliverFrame(listener, update);
        }
      }
      if (update) for (const listener of [...this.listeners]) this.deliver(listener);
    });
  }

  private deliver(listener: (snapshot: ConversationSubmissionSnapshot) => void): void {
    try {
      const result: unknown = listener(this.snapshot);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        this.listeners.delete(listener);
      }
    } catch {
      this.listeners.delete(listener);
    }
  }

  /** Register and read the baseline synchronously, so a connection cannot miss an intervening update. */
  connect(listener: (snapshot: ConversationSubmissionSnapshot) => void): () => void {
    this.listeners.add(listener);
    this.deliver(listener);
    return () => this.listeners.delete(listener);
  }

  connectFrames(listener: (frame: ConversationSubmissionFrame) => void): () => void {
    this.frameListeners.set(listener, -1);
    this.deliverFrame(listener, this.baseline);
    return () => this.frameListeners.delete(listener);
  }

  private deliverFrame(listener: (frame: ConversationSubmissionFrame) => void, frame: ConversationSubmissionFrame): void {
    if (!this.frameListeners.has(listener)) return;
    // Set ownership before invoking a consumer, which may synchronously reconnect.
    if (frame.type === 'baseline') this.frameListeners.set(listener, frame.submission.revision);
    else if (frame.type === 'submission') this.frameListeners.set(listener, frame.revision);
    try {
      const result: unknown = listener(frame);
      if (result !== undefined) {
        void Promise.resolve(result).catch(() => undefined);
        this.frameListeners.delete(listener);
      }
    } catch {
      this.frameListeners.delete(listener);
    }
  }

  async ready(signal?: AbortSignal): Promise<ConversationSubmissionSnapshot> {
    const ready = (snapshot: ConversationSubmissionSnapshot) => !!snapshot.input || !!snapshot.result || snapshot.integrity.status === 'incomplete';
    signal?.throwIfAborted();
    if (ready(this.state)) return this.snapshot;
    return new Promise((resolve, reject) => {
      const close = () => {
        this.listeners.delete(listener);
        signal?.removeEventListener('abort', aborted);
      };
      const aborted = () => {
        close();
        reject(signal!.reason);
      };
      const listener = (snapshot: ConversationSubmissionSnapshot) => {
        if (!ready(snapshot)) return;
        close();
        resolve(snapshot);
      };
      this.listeners.add(listener);
      signal?.addEventListener('abort', aborted, { once: true });
    });
  }
}

export interface SubmissionRetention {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
}

/** Process-local feedback retention. Eviction never cancels or queues runtime work. */
export function createSubmissionStore(options: SubmissionRetention & { admission?: (conversationId: string) => ConversationAdmission } = {}) {
  const entries = new Map<string, ConversationSubmission>();
  const maximum = options.maxEntries ?? 128;
  const ttlMs = options.ttlMs ?? 5 * 60_000;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('Invalid submission retention');
  const expire = () => {
    const now = Date.now();
    for (const [id, submission] of entries) if (submission.endedAt !== undefined && now - submission.endedAt >= ttlMs) entries.delete(id);
  };
  return {
    get available(): boolean {
      expire();
      return entries.size < maximum || [...entries.values()].some((entry) => entry.endedAt !== undefined);
    },
    get(id: string): ConversationSubmission | undefined {
      expire();
      return entries.get(id);
    },
    active(conversationId: string): ConversationSubmission | undefined {
      expire();
      for (const submission of entries.values()) if (submission.conversationId === conversationId && submission.endedAt === undefined) return submission;
      return undefined;
    },
    create(id: string, conversationId: string): ConversationSubmission {
      expire();
      if (entries.has(id)) throw new RuntimeError('SUBMISSION_EXISTS', '该提交仍在保留范围内，请查询其进展。');
      if (entries.size >= maximum) {
        const oldest = [...entries.values()].filter((entry) => entry.endedAt !== undefined).sort((left, right) => left.endedAt! - right.endedAt!)[0];
        if (oldest) entries.delete(oldest.id);
      }
      if (entries.size >= maximum) throw new RuntimeError('SUBMISSION_CAPACITY', '暂时无法保留新的提交进展，请稍后再试。');
      const submission = new ConversationSubmission(id, conversationId, { admission: options.admission ? () => options.admission!(conversationId) : undefined });
      entries.set(id, submission);
      return submission;
    },
  };
}
