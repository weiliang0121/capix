import type { ConversationSubmissionSnapshot } from '@capix/protocol';
import { isEqual } from 'es-toolkit';

export type SubmissionFeedback = { readonly status: 'connecting' | 'following' | 'ended' } | { readonly status: 'interrupted'; readonly error: unknown };
export interface ClientSubmissionState {
  readonly id: string;
  readonly pending: string;
  readonly remote?: ConversationSubmissionSnapshot;
  readonly feedback: SubmissionFeedback;
  readonly notificationError?: unknown;
}

export class SubmissionContractError extends Error {}

/** Local tracking of one submission. Connection state never invents a remote result. */
export class ClientSubmission {
  readonly id = globalThis.crypto.randomUUID();
  private state: ClientSubmissionState;
  private accepted = false;

  constructor(
    pending: string,
    private readonly notifyAccepted?: () => undefined,
  ) {
    this.state = { id: this.id, pending, feedback: { status: 'connecting' } };
  }

  get snapshot(): ClientSubmissionState {
    return this.state;
  }

  feedback(feedback: SubmissionFeedback): void {
    this.state = { ...this.state, feedback };
  }

  receive(next: ConversationSubmissionSnapshot): void {
    const previous = this.state.remote;
    assertSubmissionSnapshot(next, this.id);
    if (previous) {
      if (next.revision < previous.revision) return;
      if (next.revision === previous.revision) {
        if (!isEqual(next, previous)) throw new SubmissionContractError('同一提交修订包含不同事实。');
        this.feedback({ status: submissionFeedbackEnded(previous) ? 'ended' : 'following' });
        return;
      }
      if ((previous.input && !isEqual(next.input, previous.input)) || (previous.answer && !isEqual(next.answer, previous.answer)) || (previous.result && !isEqual(next.result, previous.result)) || (previous.integrity.status === 'incomplete' && !isEqual(next.integrity, previous.integrity)) || previous.executions.some((execution, index) => !isEqual(execution, next.executions[index]))) throw new SubmissionContractError('提交反馈中的既有事实发生回退或改变。');
    }
    const remote = copySubmission(next);
    this.state = { ...this.state, remote, feedback: { status: submissionFeedbackEnded(remote) ? 'ended' : 'following' } };
    if (remote.input && !this.accepted) {
      this.accepted = true;
      try {
        const returned: unknown = this.notifyAccepted?.();
        if (returned !== undefined) {
          // Notification is synchronous; an accidental Promise cannot escape as an unhandled rejection.
          void Promise.resolve(returned).catch(() => undefined);
          throw new TypeError('Acceptance notifications must return undefined synchronously');
        }
      } catch (notificationError) {
        this.state = { ...this.state, notificationError };
      }
    }
  }
}

export function submissionFeedbackEnded(snapshot: ConversationSubmissionSnapshot): boolean {
  return Boolean(snapshot.result) || snapshot.integrity.status === 'incomplete';
}

export function assertSubmissionSnapshot(snapshot: ConversationSubmissionSnapshot, expectedId: string): void {
  if (snapshot.submissionId !== expectedId || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 || !Array.isArray(snapshot.executions) || new Set(snapshot.executions.map((execution) => execution.contextId)).size !== snapshot.executions.length || snapshot.executions.some((execution) => !execution.contextId) || !snapshot.integrity || !['complete', 'incomplete'].includes(snapshot.integrity.status)) throw new SubmissionContractError('提交反馈身份或修订格式无效。');
  if (snapshot.input && (!snapshot.input.transcriptId || !Number.isSafeInteger(snapshot.input.start) || !Number.isSafeInteger(snapshot.input.end) || snapshot.input.start < 0 || snapshot.input.end <= snapshot.input.start || (snapshot.input.revision !== undefined && (!Number.isSafeInteger(snapshot.input.revision) || snapshot.input.revision < 0)))) throw new SubmissionContractError('提交输入范围无效。');
  if ((snapshot.result && !['completed', 'failed', 'rejected'].includes(snapshot.result.status)) || (snapshot.result && snapshot.result.status !== 'completed' && !validFailure(snapshot.result.error)) || (snapshot.integrity.status === 'incomplete' && !validFailure(snapshot.integrity.error))) throw new SubmissionContractError('提交结果或来源完整性诊断无效。');
  if (snapshot.answer && (!snapshot.input || !Number.isSafeInteger(snapshot.answer.index) || snapshot.answer.transcriptId !== snapshot.input.transcriptId || snapshot.answer.index < snapshot.input.end)) throw new SubmissionContractError('提交回答位置与输入范围不一致。');
}

function copySubmission(snapshot: ConversationSubmissionSnapshot): ConversationSubmissionSnapshot {
  return Object.freeze({
    submissionId: snapshot.submissionId,
    revision: snapshot.revision,
    ...(snapshot.input ? { input: Object.freeze({ ...snapshot.input }) } : {}),
    ...(snapshot.answer ? { answer: Object.freeze({ ...snapshot.answer }) } : {}),
    executions: Object.freeze(snapshot.executions.map((execution) => Object.freeze({ ...execution }))),
    ...(snapshot.result ? { result: Object.freeze({ ...snapshot.result, ...('error' in snapshot.result ? { error: Object.freeze({ ...snapshot.result.error }) } : {}) }) } : {}),
    integrity: Object.freeze({ ...snapshot.integrity, ...('error' in snapshot.integrity ? { error: Object.freeze({ ...snapshot.integrity.error }) } : {}) }),
  });
}

function validFailure(error: { code: string; message: string }): boolean {
  return Boolean(error && typeof error.code === 'string' && error.code.length && typeof error.message === 'string');
}
