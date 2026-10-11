import type { ConversationRequest, ConversationSubmissionSnapshot, FileTask } from '@capix/protocol';
import { isEqual } from 'es-toolkit';
import type { ConversationTransport } from './transport.js';
import { acceptConversationRequest } from './request.js';
import { acceptActivities } from './activities.js';
import { acceptFileOutput } from './files.js';
import { acceptConversationTask } from './task.js';
import { validAdmission } from './admission.js';

export type SubmissionFeedback = { readonly status: 'idle' | 'connecting' | 'following' | 'ended' } | { readonly status: 'interrupted'; readonly error: unknown };
export type SubmissionCancellation = { readonly status: 'requested' | 'sending' | 'acknowledged' } | { readonly status: 'uncertain'; readonly error: unknown };
export interface ClientSubmissionState {
  readonly id: string;
  /** Stable local input identity; a rejected admission may require a new POST identity. */
  readonly queueId: string;
  readonly pending: string;
  readonly fileTask?: FileTask;
  readonly remote?: ConversationSubmissionSnapshot;
  readonly feedback: SubmissionFeedback;
  readonly notificationError?: unknown;
  readonly cancellation?: SubmissionCancellation;
}

export interface SubmissionReception {
  readonly transcriptId: string;
  readonly changed: () => void;
}

export class SubmissionContractError extends Error {}

/** Local tracking of one submission. Connection state never invents a remote result. */
export class ClientSubmission {
  readonly id = globalThis.crypto.randomUUID();
  private state: ClientSubmissionState;
  private accepted = false;
  private session?: AbortController;
  private transcriptId?: string;
  private sent = false;
  private cancellationTask?: Promise<void>;
  private cancellationRevision = -1;
  readonly input: ConversationRequest;
  readonly bytes: number;

  constructor(
    input: ConversationRequest,
    private readonly notifyAccepted?: (submission: ClientSubmissionState) => undefined,
    queueId = this.id,
  ) {
    const accepted = acceptConversationRequest(input);
    this.input = accepted.input;
    this.bytes = accepted.bytes;
    this.state = Object.freeze({ id: this.id, queueId, pending: this.input.messages.at(-1)!.content, ...(this.input.fileTask ? { fileTask: this.input.fileTask } : {}), feedback: Object.freeze({ status: 'idle' }) });
  }

  get snapshot(): ClientSubmissionState {
    return this.state;
  }

  /** Consume one feedback connection. Reconnection never submits business input itself. */
  async connect(connect: (receive: (snapshot: ConversationSubmissionSnapshot) => void, signal: AbortSignal) => Promise<void>, reception: SubmissionReception): Promise<void> {
    this.bindReception(reception);
    const previous = this.session;
    const session = new AbortController();
    this.session = session;
    this.feedback({ status: 'connecting' });
    const current = () => this.session === session && !session.signal.aborted;
    previous?.abort();
    if (!current()) return;
    reception.changed();
    if (!current()) return;
    try {
      await connect((snapshot) => {
        if (!current()) return;
        this.receive(snapshot);
        this.feedback({ status: submissionFeedbackEnded(this.state.remote!) ? 'ended' : 'following' });
        reception.changed();
      }, session.signal);
      if (!current()) return;
      const remote = this.state.remote;
      if (!remote || !submissionFeedbackEnded(remote)) throw new Error('提交反馈连接已结束，远端结果仍未确认。');
      this.feedback({ status: 'ended' });
    } catch (error) {
      if (!current()) return;
      this.feedback({ status: 'interrupted', error });
    } finally {
      if (current()) {
        this.session = undefined;
        reception.changed();
      }
    }
  }

  /** Stop local feedback only. The caller coordinates publication with its other state changes. */
  stopFollowing(): void {
    const session = this.session;
    this.session = undefined;
    if (this.state.feedback.status !== 'ended') this.feedback({ status: 'ended' });
    session?.abort();
  }

  feedback(feedback: SubmissionFeedback): void {
    this.state = Object.freeze({ ...this.state, feedback: Object.freeze({ ...feedback }) });
  }

  receive(next: ConversationSubmissionSnapshot): void {
    const previous = this.state.remote;
    assertSubmissionSnapshot(next, this.id);
    if (next.input && this.transcriptId && next.input.transcriptId !== this.transcriptId) throw new SubmissionContractError('提交输入不属于当前消息集合。');
    if (previous && next.revision < previous.revision) return;
    let activities;
    let task;
    let fileOutput;
    try {
      activities = acceptActivities(next.activities, previous?.activities);
      task = acceptConversationTask(next.task, previous?.task, this.input.fileTask);
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
    this.state = Object.freeze({ ...this.state, remote, ...(remote.cancelRequested && this.state.cancellation ? { cancellation: Object.freeze({ status: 'acknowledged' as const }) } : {}) });
  }

  get dispatched(): boolean {
    return this.sent;
  }

  send(transport: ConversationTransport, reception: SubmissionReception): Promise<void> {
    if (this.sent) throw new Error('同一提交不能重复发送。');
    this.sent = true;
    return this.connect((receive, signal) => transport.submit({ submissionId: this.id, input: this.input }, receive, signal), reception);
  }

  private bindReception(reception: SubmissionReception): void {
    if (this.transcriptId && this.transcriptId !== reception.transcriptId) throw new SubmissionContractError('提交不能切换消息集合。');
    this.transcriptId = reception.transcriptId;
  }

  /** A control response accepts facts without pretending a feedback connection is open. */
  async refresh(transport: ConversationTransport, reception: SubmissionReception, signal?: AbortSignal): Promise<void> {
    this.bindReception(reception);
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const snapshot = await transport.read(this.id, requestSignal);
    requestSignal.throwIfAborted();
    this.receive(snapshot);
    reception.changed();
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
      this.receive(await transport.cancel(this.id, AbortSignal.timeout(10_000)));
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
  if (snapshot.submissionId !== expectedId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.executions) || new Set(snapshot.executions.map((execution) => execution.contextId)).size !== snapshot.executions.length || snapshot.executions.some((execution) => !execution.contextId) || !snapshot.integrity || !['complete', 'incomplete'].includes(snapshot.integrity.status)) throw new SubmissionContractError('提交反馈身份或修订格式无效。');
  if (snapshot.input && (!snapshot.input.transcriptId || !Number.isSafeInteger(snapshot.input.start) || !Number.isSafeInteger(snapshot.input.end) || snapshot.input.start < 0 || snapshot.input.end <= snapshot.input.start || (snapshot.input.revision !== undefined && (!Number.isSafeInteger(snapshot.input.revision) || snapshot.input.revision < 0)))) throw new SubmissionContractError('提交输入范围无效。');
  if ((snapshot.result && !['completed', 'cancelled', 'failed', 'rejected'].includes(snapshot.result.status)) || (snapshot.result && (snapshot.result.status === 'failed' || snapshot.result.status === 'rejected') && !validFailure(snapshot.result.error)) || (snapshot.integrity.status === 'incomplete' && !validFailure(snapshot.integrity.error))) throw new SubmissionContractError('提交结果或来源完整性诊断无效。');
  if (snapshot.result && snapshot.fileOutput?.status === 'pending') throw new SubmissionContractError('已结束的提交不能保留待创建的文件状态。');
  if (snapshot.task !== undefined && !snapshot.input) throw new SubmissionContractError('处理任务需要已接纳的输入。');
  if (snapshot.result?.status === 'rejected' && (snapshot.task !== undefined || snapshot.fileOutput !== undefined)) throw new SubmissionContractError('未接纳的提交不能包含任务或文件执行事实。');
  if (snapshot.cancelRequested !== undefined && snapshot.cancelRequested !== true) throw new SubmissionContractError('取消请求事实无效。');
  if (snapshot.result?.status === 'cancelled' && !snapshot.cancelRequested) throw new SubmissionContractError('取消结果缺少取消请求事实。');
  if (snapshot.answer && (!snapshot.input || !Number.isSafeInteger(snapshot.answer.index) || snapshot.answer.transcriptId !== snapshot.input.transcriptId || snapshot.answer.index < snapshot.input.end)) throw new SubmissionContractError('提交回答位置与输入范围不一致。');
  if (snapshot.result && 'retry' in snapshot.result && (snapshot.result.status !== 'rejected' || snapshot.result.retry !== 'admission' || snapshot.integrity.status !== 'complete' || snapshot.input || snapshot.answer || snapshot.executions.length)) throw new SubmissionContractError('重新接纳只能用于明确未受理的提交。');
  if (snapshot.admission !== undefined && !validAdmission(snapshot.admission)) throw new SubmissionContractError('服务接纳状态无效。');
}

function copySubmission(snapshot: ConversationSubmissionSnapshot): ConversationSubmissionSnapshot {
  return Object.freeze({
    submissionId: snapshot.submissionId,
    revision: snapshot.revision,
    ...(snapshot.cancelRequested ? { cancelRequested: true as const } : {}),
    ...(snapshot.input ? { input: Object.freeze({ ...snapshot.input }) } : {}),
    ...(snapshot.answer ? { answer: Object.freeze({ ...snapshot.answer }) } : {}),
    executions: Object.freeze(snapshot.executions.map((execution) => Object.freeze({ ...execution }))),
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
