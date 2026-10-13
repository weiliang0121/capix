import type { ConversationRequest, ConversationSubmissionSnapshot, ConversationSubmissionFrame, ConversationSubmissionBaseline, ConversationSubmissionUpdate, FileTask } from '@capix/protocol';
import { isEqual } from 'es-toolkit';
import { SubmissionUnavailableError, type ConversationTransport } from './transport.js';
import { acceptConversationRequest } from './request.js';
import { acceptActivities, acceptActivityChange } from './activities.js';
import { acceptFileOutput } from './files.js';
import { acceptConversationTask } from './task.js';
import { validAdmission } from './admission.js';
import { AnswerPreviewReceiver, type AnswerPreviewState } from './preview.js';

export type SubmissionFeedback = { readonly status: 'idle' | 'connecting' | 'following' | 'ended' } | { readonly status: 'interrupted' | 'unavailable'; readonly error: unknown };
export type SubmissionCancellation = { readonly status: 'requested' | 'sending' | 'acknowledged' } | { readonly status: 'uncertain'; readonly error: unknown };
export interface ClientSubmissionState {
  readonly id: string;
  readonly conversationId: string;
  /** Stable local input identity; a rejected admission may require a new POST identity. */
  readonly queueId?: string;
  readonly pending?: string;
  readonly fileTask?: FileTask;
  readonly remote?: ConversationSubmissionSnapshot;
  readonly feedback: SubmissionFeedback;
  readonly notificationError?: unknown;
  readonly cancellation?: SubmissionCancellation;
  readonly preview?: AnswerPreviewState;
}

export interface SubmissionReception {
  readonly transcriptId: string;
  readonly changed: () => void;
  readonly recoverPreview?: (signal: AbortSignal) => Promise<ConversationSubmissionBaseline>;
}

export class SubmissionContractError extends Error {}

/** Local tracking of one submission. Connection state never invents a remote result. */
export class ClientSubmission {
  readonly id: string;
  readonly conversationId: string;
  private readonly notifyAccepted?: (submission: ClientSubmissionState) => undefined;
  private state: ClientSubmissionState;
  private accepted = false;
  private session?: AbortController;
  private transcriptId?: string;
  private sent = false;
  private cancellationTask?: Promise<void>;
  private cancellationRevision = -1;
  private readonly previews = new AnswerPreviewReceiver();
  private executionPositions = new Map<string, number>();
  readonly input?: ConversationRequest;
  readonly bytes: number;

  constructor(identity: { readonly conversationId: string; readonly submissionId: string });
  constructor(conversationId: string, input: ConversationRequest, notifyAccepted?: (submission: ClientSubmissionState) => undefined, queueId?: string);
  constructor(identity: string | { readonly conversationId: string; readonly submissionId: string }, input?: ConversationRequest, notifyAccepted?: (submission: ClientSubmissionState) => undefined, queueId?: string) {
    const conversationId = typeof identity === 'string' ? identity : identity.conversationId;
    if (typeof conversationId !== 'string' || !conversationId) throw new TypeError('提交必须明确所属对话。');
    this.conversationId = conversationId;
    if (typeof identity !== 'string') {
      if (typeof identity.submissionId !== 'string' || !identity.submissionId) throw new TypeError('接回提交必须明确原提交身份。');
      this.id = identity.submissionId;
      this.bytes = 0;
      this.sent = true;
      this.accepted = true;
      this.state = Object.freeze({ id: this.id, conversationId, feedback: Object.freeze({ status: 'connecting' }) });
      return;
    }
    const accepted = acceptConversationRequest(input!);
    this.id = globalThis.crypto.randomUUID();
    this.notifyAccepted = notifyAccepted;
    this.input = accepted.input;
    this.bytes = accepted.bytes;
    this.state = Object.freeze({ id: this.id, conversationId, queueId: queueId ?? this.id, pending: this.input.messages.at(-1)!.content, ...(this.input.fileTask ? { fileTask: this.input.fileTask } : {}), feedback: Object.freeze({ status: 'idle' }) });
  }

  /** Attach to existing facts without manufacturing a local request or another POST identity. */
  static attach(identity: { readonly conversationId: string; readonly submissionId: string }, transcriptId: string, baseline?: ConversationSubmissionBaseline): ClientSubmission {
    const submission = new ClientSubmission(identity);
    submission.bindReception({ transcriptId, changed: () => undefined });
    if (baseline) {
      submission.receiveFrame(baseline);
      if (submission.snapshot.remote && submissionFeedbackEnded(submission.snapshot.remote)) submission.feedback({ status: 'ended' });
    }
    return submission;
  }

  get snapshot(): ClientSubmissionState {
    return this.state;
  }

  /** Consume one feedback connection. Reconnection never submits business input itself. */
  async connect(connect: (receive: (frame: ConversationSubmissionFrame) => void, signal: AbortSignal) => Promise<void>, reception: SubmissionReception): Promise<void> {
    this.bindReception(reception);
    const previous = this.session;
    const session = new AbortController();
    this.session = session;
    const connectingState = this.state;
    this.feedback({ status: 'connecting' });
    const current = () => this.session === session && !session.signal.aborted;
    previous?.abort();
    if (!current()) return;
    if (this.state !== connectingState) reception.changed();
    if (!current()) return;
    let completionChanged = false;
    let previewRecovery: Promise<void> | undefined;
    let previewRecoveries = 0;
    try {
      await connect((frame) => {
        if (!current()) return;
        const receivingState = this.state;
        this.receiveFrame(frame);
        if (!current()) return;
        this.feedback({ status: this.state.remote && submissionFeedbackEnded(this.state.remote) ? 'ended' : 'following' });
        if (this.state !== receivingState) reception.changed();
        if (current() && this.state.preview?.status === 'interrupted' && reception.recoverPreview && !previewRecovery && previewRecoveries < 2) {
          previewRecoveries++;
          previewRecovery = Promise.resolve()
            .then(() => reception.recoverPreview!(AbortSignal.any([session.signal, AbortSignal.timeout(10_000)])))
            .then((baseline) => {
              if (!current()) return;
              const recoveringState = this.state;
              this.receiveFrame(baseline);
              if (current() && this.state !== recoveringState) reception.changed();
            })
            .catch(() => undefined)
            .finally(() => {
              previewRecovery = undefined;
            });
        }
      }, session.signal);
      if (!current()) return;
      const remote = this.state.remote;
      if (!remote || !submissionFeedbackEnded(remote)) throw new Error('提交反馈连接已结束，远端结果仍未确认。');
      const completingState = this.state;
      this.feedback({ status: 'ended' });
      completionChanged = this.state !== completingState;
    } catch (error) {
      if (!current()) return;
      const failingState = this.state;
      this.feedback({ status: error instanceof SubmissionUnavailableError ? 'unavailable' : 'interrupted', error });
      completionChanged = this.state !== failingState;
    } finally {
      if (current()) {
        this.session = undefined;
        if (completionChanged) reception.changed();
      }
    }
  }

  /** Stop local feedback only. The caller coordinates publication with its other state changes. */
  stopFollowing(): void {
    const session = this.session;
    this.session = undefined;
    if (this.state.feedback.status !== 'ended' && this.state.feedback.status !== 'unavailable') this.feedback({ status: 'ended' });
    session?.abort();
  }

  feedback(feedback: SubmissionFeedback): void {
    const previous = this.state.feedback;
    if (feedback.status === previous.status && (!('error' in feedback) || ('error' in previous && feedback.error === previous.error))) return;
    this.state = Object.freeze({ ...this.state, feedback: Object.freeze({ ...feedback }) });
  }

  receiveFrame(frame: ConversationSubmissionFrame): void {
    if (frame.type === 'answer') {
      if (frame.submissionId !== this.id || frame.conversationId !== this.conversationId) throw new SubmissionContractError('回答预览不属于本次提交。');
      this.previews.receive(frame.change);
    } else if (frame.type === 'baseline') {
      this.receive(frame.submission);
      this.previews.baseline(frame.preview);
    } else if (frame.type === 'submission') {
      this.receiveUpdate(frame);
    } else throw new SubmissionContractError('提交反馈帧类型无效。');
    this.previews.associate(this.state.remote?.input, this.state.remote?.answer, Boolean(this.state.remote?.result && this.state.remote.integrity.status === 'complete'));
    if (this.previews.snapshot !== this.state.preview) this.state = Object.freeze({ ...this.state, ...(this.previews.snapshot ? { preview: this.previews.snapshot } : {}) });
  }

  receive(next: ConversationSubmissionSnapshot): void {
    const previous = this.state.remote;
    assertSubmissionSnapshot(next, this.id);
    if (next.conversationId !== this.conversationId) throw new SubmissionContractError('提交反馈不属于本次对话。');
    if (next.input && this.transcriptId && next.input.transcriptId !== this.transcriptId) throw new SubmissionContractError('提交输入不属于当前消息集合。');
    if (previous && next.revision < previous.revision) return;
    let activities;
    let task;
    let fileOutput;
    try {
      activities = acceptActivities(next.activities, previous?.activities);
      task = acceptConversationTask(next.task, previous?.task, this.input?.fileTask);
      fileOutput = acceptFileOutput(next.fileOutput, previous?.fileOutput, task?.kind === 'file' ? task.task : undefined);
    } catch (cause) {
      throw new SubmissionContractError('提交过程或文件结果无效。', { cause });
    }
    const accepted = { ...next, ...(activities ? { activities } : {}), ...(task ? { task } : {}), ...(fileOutput ? { fileOutput } : {}) };
    if (previous) {
      if (next.revision === previous.revision) {
        if (!isEqual(accepted, previous)) throw new SubmissionContractError('同一提交修订包含不同事实。');
        return;
      }
      if ((previous.cancelRequested && !next.cancelRequested) || (previous.input && !isEqual(next.input, previous.input)) || (previous.answer && !isEqual(next.answer, previous.answer)) || (previous.result && !isEqual(next.result, previous.result)) || (previous.integrity.status === 'incomplete' && !isEqual(next.integrity, previous.integrity)) || previous.executions.some((execution, index) => !isEqual(execution, next.executions[index]))) throw new SubmissionContractError('提交反馈中的既有事实发生回退或改变。');
    }
    const remote = copySubmission(accepted);
    this.executionPositions = new Map(remote.executions.map((execution, index) => [execution.contextId, index]));
    this.state = Object.freeze({ ...this.state, remote, ...(remote.cancelRequested && this.state.cancellation ? { cancellation: Object.freeze({ status: 'acknowledged' as const }) } : {}) });
  }

  private receiveUpdate(frame: ConversationSubmissionUpdate): void {
    if (frame.conversationId !== this.conversationId || frame.submissionId !== this.id || !Number.isSafeInteger(frame.fromRevision) || frame.fromRevision < 0 || !Number.isSafeInteger(frame.revision) || frame.revision <= frame.fromRevision || !frame.change || typeof frame.change !== 'object' || Array.isArray(frame.change)) throw new SubmissionContractError('提交增量身份或修订格式无效。');
    const previous = this.state.remote;
    if (!previous) throw new SubmissionContractError('提交增量缺少完整基线。');
    if (frame.revision < previous.revision) return;
    if (frame.fromRevision > previous.revision) throw new SubmissionContractError('提交增量修订存在缺口。');
    const change = frame.change;
    let executions = previous.executions;
    let positions = this.executionPositions;
    if (change.executions !== undefined) {
      if (!Array.isArray(change.executions)) throw new SubmissionContractError('提交执行增量格式无效。');
      const seen = new Set<string>();
      const appended: { readonly contextId: string }[] = [];
      let lastPosition = -1;
      for (const execution of change.executions) {
        if (!execution || typeof execution.contextId !== 'string' || !execution.contextId || seen.has(execution.contextId)) throw new SubmissionContractError('提交执行增量身份无效。');
        seen.add(execution.contextId);
        const position = positions.get(execution.contextId);
        if (position !== undefined) {
          if (appended.length || position <= lastPosition || frame.fromRevision === previous.revision) throw new SubmissionContractError('提交执行增量顺序无效。');
          lastPosition = position;
        } else appended.push(Object.freeze({ contextId: execution.contextId }));
      }
      if (appended.length) {
        positions = new Map(positions);
        for (const [index, execution] of appended.entries()) positions.set(execution.contextId, executions.length + index);
        executions = Object.freeze([...executions, ...appended]);
      }
    }
    let activities = previous.activities;
    let task = previous.task;
    let fileOutput = previous.fileOutput;
    try {
      if (change.activities !== undefined) activities = acceptActivityChange(change.activities, previous.activities);
      if (change.task !== undefined) task = acceptConversationTask(change.task, previous.task, this.input?.fileTask);
      if (change.fileOutput !== undefined) fileOutput = acceptFileOutput(change.fileOutput, previous.fileOutput, task?.kind === 'file' ? task.task : undefined);
    } catch (cause) {
      throw new SubmissionContractError('提交过程或文件结果无效。', { cause });
    }
    const next: ConversationSubmissionSnapshot = {
      ...previous,
      revision: frame.revision,
      ...(change.input !== undefined ? { input: change.input } : {}),
      ...(change.answer !== undefined ? { answer: change.answer } : {}),
      ...(change.cancelRequested !== undefined ? { cancelRequested: change.cancelRequested } : {}),
      ...(change.result !== undefined ? { result: change.result } : {}),
      ...(change.integrity !== undefined ? { integrity: change.integrity } : {}),
      ...(change.admission !== undefined ? { admission: change.admission ?? undefined } : {}),
      executions,
      ...(activities ? { activities } : {}),
      ...(task ? { task } : {}),
      ...(fileOutput ? { fileOutput } : {}),
    };
    assertSubmissionFacts(next);
    if (next.input && this.transcriptId && next.input.transcriptId !== this.transcriptId) throw new SubmissionContractError('提交输入不属于当前消息集合。');
    if ((previous.input && !isEqual(next.input, previous.input)) || (previous.answer && !isEqual(next.answer, previous.answer)) || (previous.result && !isEqual(next.result, previous.result)) || (previous.integrity.status === 'incomplete' && !isEqual(next.integrity, previous.integrity))) throw new SubmissionContractError('提交反馈中的既有事实发生回退或改变。');
    if (frame.revision === previous.revision) {
      if (executions !== previous.executions || activities !== previous.activities || !isEqual(next.input, previous.input) || !isEqual(next.answer, previous.answer) || !isEqual(next.task, previous.task) || !isEqual(next.fileOutput, previous.fileOutput) || next.cancelRequested !== previous.cancelRequested || !isEqual(next.result, previous.result) || !isEqual(next.integrity, previous.integrity) || !isEqual(next.admission, previous.admission)) throw new SubmissionContractError('同一提交修订包含不同事实。');
      return;
    }
    const remote = copySubmission(next, false);
    this.executionPositions = positions;
    this.state = Object.freeze({ ...this.state, remote, ...(remote.cancelRequested && this.state.cancellation ? { cancellation: Object.freeze({ status: 'acknowledged' as const }) } : {}) });
  }

  get dispatched(): boolean {
    return this.sent;
  }

  send(transport: ConversationTransport, reception: SubmissionReception): Promise<void> {
    if (this.sent || !this.input) throw new Error('同一提交不能重复发送。');
    this.sent = true;
    const input = this.input;
    return this.connect((receive, signal) => transport.submit({ conversationId: this.conversationId, submissionId: this.id, input }, receive, signal), reception);
  }

  private bindReception(reception: SubmissionReception): void {
    if (typeof reception.transcriptId !== 'string' || !reception.transcriptId) throw new SubmissionContractError('提交接收必须绑定消息集合。');
    if (this.transcriptId && this.transcriptId !== reception.transcriptId) throw new SubmissionContractError('提交不能切换消息集合。');
    this.transcriptId = reception.transcriptId;
  }

  /** A control response accepts facts without pretending a feedback connection is open. */
  async refresh(transport: ConversationTransport, reception: SubmissionReception, signal?: AbortSignal): Promise<void> {
    this.bindReception(reception);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    try {
      const snapshot = await transport.read(this.id, requestSignal);
      requestSignal.throwIfAborted();
      this.receiveFrame(snapshot);
      if (this.state.remote && submissionFeedbackEnded(this.state.remote)) this.feedback({ status: 'ended' });
      else if (this.state.feedback.status === 'unavailable') this.feedback({ status: this.session ? 'following' : 'ended' });
      reception.changed();
    } catch (error) {
      if (!signal?.aborted) {
        this.feedback({ status: error instanceof SubmissionUnavailableError ? 'unavailable' : 'interrupted', error });
        reception.changed();
      }
      throw error;
    }
  }

  get shouldRetryCancellation(): boolean {
    return this.state.cancellation?.status === 'uncertain' && !!this.state.remote && !this.state.remote.result && !this.state.remote.cancelRequested && this.state.remote.revision > this.cancellationRevision;
  }

  /** Request delivery and actual cancellation are separate facts. Never abort feedback here. */
  requestCancellation(transport: ConversationTransport, reception: SubmissionReception): Promise<void> {
    this.bindReception(reception);
    if (this.state.remote?.result || this.state.remote?.cancelRequested) return Promise.resolve();
    if (this.cancellationTask) return this.cancellationTask;
    this.state = Object.freeze({ ...this.state, cancellation: Object.freeze({ status: 'requested' }) });
    // Establish single-flight ownership before consumers can synchronously reenter.
    const task = Promise.resolve().then(() => this.cancel(transport, reception));
    this.cancellationTask = task;
    reception.changed();
    return task;
  }

  private async cancel(transport: ConversationTransport, reception: SubmissionReception): Promise<void> {
    try {
      if (this.state.remote?.result || this.state.remote?.cancelRequested) return;
      this.cancellationRevision = this.state.remote?.revision ?? -1;
      this.state = Object.freeze({ ...this.state, cancellation: Object.freeze({ status: 'sending' }) });
      reception.changed();
      this.receiveFrame(await transport.cancel(this.id, AbortSignal.timeout(10_000)));
      if (!this.state.remote?.cancelRequested && !this.state.remote?.result) throw new SubmissionContractError('服务未确认取消请求。');
    } catch (error) {
      if (!this.state.remote?.cancelRequested && !this.state.remote?.result) this.state = Object.freeze({ ...this.state, cancellation: Object.freeze({ status: 'uncertain' as const, error }) });
    } finally {
      this.cancellationTask = undefined;
      reception.changed();
    }
  }

  get acceptancePending(): boolean {
    return Boolean(this.state.remote?.input) && !this.accepted;
  }

  /** Once notification after publication; payload identifies even explicitly released tracking. */
  publishAcceptance(snapshot: ClientSubmissionState): void {
    if (snapshot.id !== this.id || !snapshot.remote?.input || this.accepted) return;
    this.accepted = true;
    try {
      const returned: unknown = this.notifyAccepted?.(snapshot);
      if (returned !== undefined) {
        // Notification is synchronous; an accidental Promise cannot escape as an unhandled rejection.
        void Promise.resolve(returned).catch(() => undefined);
        throw new TypeError('Acceptance notifications must return undefined synchronously');
      }
    } catch (notificationError) {
      this.state = Object.freeze({ ...this.state, notificationError });
    }
  }
}

export function submissionFeedbackEnded(snapshot: ConversationSubmissionSnapshot): boolean {
  return Boolean(snapshot.result) || snapshot.integrity.status === 'incomplete';
}

export function assertSubmissionSnapshot(snapshot: ConversationSubmissionSnapshot, expectedId: string): void {
  if (!snapshot.conversationId || snapshot.submissionId !== expectedId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.executions) || new Set(snapshot.executions.map((execution) => execution.contextId)).size !== snapshot.executions.length || snapshot.executions.some((execution) => !execution.contextId) || !snapshot.integrity || !['complete', 'incomplete'].includes(snapshot.integrity.status)) throw new SubmissionContractError('提交反馈身份或修订格式无效。');
  assertSubmissionFacts(snapshot);
}

function assertSubmissionFacts(snapshot: ConversationSubmissionSnapshot): void {
  if (!snapshot.integrity || !['complete', 'incomplete'].includes(snapshot.integrity.status)) throw new SubmissionContractError('提交来源完整性无效。');
  if (snapshot.input && (!snapshot.input.transcriptId || !Number.isSafeInteger(snapshot.input.start) || !Number.isSafeInteger(snapshot.input.end) || snapshot.input.start < 0 || snapshot.input.end <= snapshot.input.start || (snapshot.input.revision !== undefined && (!Number.isSafeInteger(snapshot.input.revision) || snapshot.input.revision < 0)))) throw new SubmissionContractError('提交输入范围无效。');
  if ((snapshot.result && !['completed', 'cancelled', 'failed', 'rejected'].includes(snapshot.result.status)) || (snapshot.result && (snapshot.result.status === 'failed' || snapshot.result.status === 'rejected') && !validFailure(snapshot.result.error)) || (snapshot.integrity.status === 'incomplete' && !validFailure(snapshot.integrity.error))) throw new SubmissionContractError('提交结果或来源完整性诊断无效。');
  if (snapshot.result && snapshot.fileOutput?.status === 'pending') throw new SubmissionContractError('已结束的提交不能保留待创建的文件状态。');
  if (snapshot.task !== undefined && !snapshot.input) throw new SubmissionContractError('处理任务需要已接纳的输入。');
  if (snapshot.result?.status === 'rejected' && (snapshot.task !== undefined || snapshot.fileOutput !== undefined)) throw new SubmissionContractError('未接纳的提交不能包含任务或文件执行事实。');
  if (snapshot.cancelRequested !== undefined && snapshot.cancelRequested !== true) throw new SubmissionContractError('取消请求事实无效。');
  if (snapshot.result?.status === 'cancelled' && !snapshot.cancelRequested) throw new SubmissionContractError('取消结果缺少取消请求事实。');
  if (snapshot.answer && (!snapshot.input || !Number.isSafeInteger(snapshot.answer.index) || snapshot.answer.transcriptId !== snapshot.input.transcriptId || snapshot.answer.index < snapshot.input.end)) throw new SubmissionContractError('提交回答位置与输入范围不一致。');
  if (snapshot.result && 'retry' in snapshot.result && (snapshot.result.status !== 'rejected' || snapshot.result.retry !== 'admission' || snapshot.integrity.status !== 'complete' || snapshot.input || snapshot.answer || snapshot.executions.length)) throw new SubmissionContractError('重新接纳只能用于明确未受理的提交。');
  if (snapshot.admission !== undefined && (!validAdmission(snapshot.admission) || snapshot.admission.conversationId !== snapshot.conversationId || (snapshot.input && snapshot.admission.transcriptId !== snapshot.input.transcriptId))) throw new SubmissionContractError('服务接纳状态无效。');
}

function copySubmission(snapshot: ConversationSubmissionSnapshot, copyExecutions = true): ConversationSubmissionSnapshot {
  return Object.freeze({
    conversationId: snapshot.conversationId,
    submissionId: snapshot.submissionId,
    revision: snapshot.revision,
    ...(snapshot.cancelRequested ? { cancelRequested: true as const } : {}),
    ...(snapshot.input ? { input: Object.freeze({ ...snapshot.input }) } : {}),
    ...(snapshot.answer ? { answer: Object.freeze({ ...snapshot.answer }) } : {}),
    executions: copyExecutions ? Object.freeze(snapshot.executions.map((execution) => Object.freeze({ ...execution }))) : snapshot.executions,
    ...(snapshot.activities ? { activities: snapshot.activities } : {}),
    ...(snapshot.task ? { task: snapshot.task } : {}),
    ...(snapshot.fileOutput ? { fileOutput: snapshot.fileOutput } : {}),
    ...(snapshot.admission ? { admission: Object.freeze({ ...snapshot.admission, ...(snapshot.admission.status === 'unavailable' ? { error: Object.freeze({ ...snapshot.admission.error }) } : {}) }) } : {}),
    ...(snapshot.result ? { result: Object.freeze({ ...snapshot.result, ...('error' in snapshot.result ? { error: Object.freeze({ ...snapshot.result.error }) } : {}) }) } : {}),
    integrity: Object.freeze({ ...snapshot.integrity, ...('error' in snapshot.integrity ? { error: Object.freeze({ ...snapshot.integrity.error }) } : {}) }),
  });
}

function validFailure(error: { code: string; message: string }): boolean {
  return Boolean(error && typeof error.code === 'string' && error.code.length && typeof error.message === 'string');
}
