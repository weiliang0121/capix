import { TranscriptConnectionError, SubmissionUnavailableError, type ConversationTransport, type TranscriptTransport } from '@capix/client-runtime';
import type { ConversationSubmissionBaseline, ConversationSubmissionFrame, ConversationSubmissionRequest, TranscriptFrame } from '@capix/protocol';
import { HttpTransport } from './transport.js';
import { HttpError, HttpTransportError } from './errors.js';
import { acceptResponse, conversationResponse, conversationsResponse, configurationResponse, admissionResponse, transcriptResponse, transcriptUpdate, submissionBaselineResponse, submissionDiscoveryResponse, submissionFrameResponse, responseStatusError, parseLine, deliver } from './responses.js';
import { readLines } from './stream.js';

/** Conversation requests and delivery, independent of observation. */
export class ConversationHttpTransport extends HttpTransport implements ConversationTransport, TranscriptTransport {
  protected override statusError = responseStatusError;

  async config() {
    return acceptResponse(configurationResponse, await this.get('/api/config'), '配置');
  }
  async conversations(signal?: AbortSignal) {
    return acceptResponse(conversationsResponse, await this.get('/api/conversations', signal), '对话列表');
  }
  async conversation(id: string, signal?: AbortSignal) {
    const value = acceptResponse(conversationResponse, await this.get(`/api/conversations/${encodeURIComponent(id)}`, signal), '对话');
    if (value.id !== id) throw new HttpTransportError('contract', '返回了不同的对话。', 'CONVERSATION_MISMATCH');
    return value;
  }
  async createConversation(signal?: AbortSignal) {
    const response = await this.send('/api/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
    return acceptResponse(conversationResponse, parseLine(await response.text()), '对话');
  }
  async admission(conversationId: string, signal?: AbortSignal) {
    const value = acceptResponse(admissionResponse, await this.get(`/api/conversation/admission?conversationId=${encodeURIComponent(conversationId)}`, signal), '对话接纳');
    if (value.conversationId !== conversationId) throw new HttpTransportError('contract', '接纳状态不属于请求的对话。', 'CONVERSATION_MISMATCH');
    return value;
  }
  async activeSubmission(conversationId: string, signal?: AbortSignal) {
    const value = acceptResponse(submissionDiscoveryResponse, await this.get(`/api/conversations/${encodeURIComponent(conversationId)}/submission`, signal), '当前提交');
    if (value.conversationId !== conversationId) throw new HttpTransportError('contract', '当前提交不属于请求的对话。', 'CONVERSATION_MISMATCH');
    const submission = value.submission?.submission;
    if (submission) {
      if (submission.conversationId !== conversationId || (submission.admission && submission.admission.conversationId !== conversationId)) throw new HttpTransportError('contract', '当前提交反馈不属于请求的对话。', 'CONVERSATION_MISMATCH');
      if ([submission.input, submission.answer, submission.admission].some((item) => item && item.transcriptId !== value.transcriptId)) throw new HttpTransportError('contract', '当前提交反馈不属于声明的消息集合。', 'TRANSCRIPT_MISMATCH');
      if (submission.result) throw new HttpTransportError('contract', '当前提交查询不能返回已结束的提交。', 'INVALID_RESPONSE');
    }
    return value;
  }
  async transcript(id: string, signal?: AbortSignal) {
    const snapshot = acceptResponse(transcriptResponse, await this.get(`/api/transcript?id=${encodeURIComponent(id)}`, signal), '消息');
    if (id && snapshot.id !== id) throw new HttpTransportError('contract', '返回了不同的消息集合。', 'TRANSCRIPT_MISMATCH');
    return snapshot;
  }
  async observeTranscript(id: string, accept: (frame: TranscriptFrame) => void, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.send(`/api/transcript/observe?id=${encodeURIComponent(id)}`, { signal });
      if (!response.body) throw new HttpTransportError('contract', '服务未返回消息流。', 'MISSING_STREAM');
      for await (const line of readLines(response.body)) {
        const frame = acceptResponse(transcriptUpdate, parseLine(line), '消息流');
        if (frame.type === 'error') throw new HttpTransportError('remote', frame.error, frame.code);
        deliver(() => accept(frame), '消息变化');
      }
      if (!signal.aborted) throw new HttpTransportError('contract', '消息同步连接已结束。', 'INCOMPLETE_STREAM');
    } catch (error) {
      if (signal.aborted) throw error;
      // Contract, source and delivery failures remain terminal. Callback TypeErrors
      // are already wrapped by deliver and must never masquerade as network loss.
      if (error instanceof TypeError || (error instanceof HttpError && [408, 429, 500, 502, 503, 504].includes(error.response.status)) || (error instanceof HttpTransportError && error.kind === 'contract' && error.code === 'INCOMPLETE_STREAM')) throw new TranscriptConnectionError(error.message, { cause: error });
      throw error;
    }
  }
  async submit(request: ConversationSubmissionRequest, receive: (frame: ConversationSubmissionFrame) => void, signal: AbortSignal): Promise<void> {
    await this.feedback('/api/run', request.submissionId, receive, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }, request.conversationId);
  }

  async follow(id: string, receive: (frame: ConversationSubmissionFrame) => void, signal: AbortSignal): Promise<void> {
    await this.feedback(`/api/submissions/${encodeURIComponent(id)}/follow`, id, receive, { signal });
  }

  async read(id: string, signal?: AbortSignal): Promise<ConversationSubmissionBaseline> {
    try {
      const value = await this.get(`/api/submissions/${encodeURIComponent(id)}`, signal);
      return this.acceptBaseline(value, id);
    } catch (error) {
      if (error instanceof HttpError && error.phase === 'status' && error.code === 'SUBMISSION_UNAVAILABLE') throw new SubmissionUnavailableError(error.message, { cause: error });
      throw error;
    }
  }

  async cancel(id: string, signal?: AbortSignal): Promise<ConversationSubmissionBaseline> {
    const response = await this.send(`/api/submissions/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal });
    return this.acceptBaseline(parseLine(await response.text()), id);
  }

  private acceptFrame(value: unknown, id: string, conversationId?: string): ConversationSubmissionFrame {
    const frame = acceptResponse(submissionFrameResponse, value, '提交');
    const identity = frame.type === 'baseline' ? frame.submission : frame;
    if (identity.submissionId !== id) throw new HttpTransportError('contract', '提交反馈身份不一致。', 'SUBMISSION_MISMATCH');
    if (conversationId && identity.conversationId !== conversationId) throw new HttpTransportError('contract', '提交反馈不属于请求的对话。', 'CONVERSATION_MISMATCH');
    return frame;
  }

  private acceptBaseline(value: unknown, id: string): ConversationSubmissionBaseline {
    const frame = this.acceptFrame(value, id);
    if (frame.type !== 'baseline') throw new HttpTransportError('contract', '提交查询缺少完整基线。', 'MISSING_BASELINE');
    return frame;
  }

  protected async feedback(path: string, id: string, receive: (frame: ConversationSubmissionFrame) => void, init: RequestInit, conversationId?: string): Promise<void> {
    let response: Response;
    try {
      response = await this.send(path, init);
    } catch (error) {
      if (init.method !== 'POST' && error instanceof HttpError && error.phase === 'status' && error.code === 'SUBMISSION_UNAVAILABLE') throw new SubmissionUnavailableError(error.message, { cause: error });
      // A known rejection is a formal cumulative fact even when HTTP uses a non-2xx status.
      if (!(error instanceof HttpError) || !submissionBaselineResponse.safeParse(error.body).success) throw error;
      const frame = this.acceptFrame(error.body, id, conversationId);
      if (frame.type !== 'baseline') throw error;
      const snapshot = frame.submission;
      deliver(() => receive(frame), '提交反馈');
      if (!snapshot.result && snapshot.integrity.status !== 'incomplete') throw new HttpTransportError('contract', 'HTTP 请求已结束，提交结果仍未确认。', 'INCOMPLETE_STREAM');
      return;
    }
    if (!response.body) throw new HttpTransportError('contract', '服务未返回提交反馈流。', 'MISSING_STREAM');
    let hasBaseline = false;
    for await (const line of readLines(response.body)) {
      const frame = this.acceptFrame(parseLine(line), id, conversationId);
      if (!hasBaseline && frame.type !== 'baseline') throw new HttpTransportError('contract', '提交反馈连接缺少完整基线。', 'MISSING_BASELINE');
      if (frame.type === 'baseline') hasBaseline = true;
      deliver(() => receive(frame), '提交反馈');
      const facts = frame.type === 'baseline' ? frame.submission : frame.type === 'submission' ? frame.change : undefined;
      if (facts?.result || facts?.integrity?.status === 'incomplete') return;
    }
    if (!init.signal?.aborted) throw new HttpTransportError('contract', '提交反馈流提前结束，远端结果仍未确认。', 'INCOMPLETE_STREAM');
  }
}
