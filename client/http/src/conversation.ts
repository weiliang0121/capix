import type { ConversationTransport, TranscriptTransport } from '@capix/client-runtime';
import type { ConversationSubmissionSnapshot, ConversationSubmissionRequest, TranscriptFrame } from '@capix/protocol';
import { HttpTransport } from './transport.js';
import { HttpError, HttpTransportError } from './errors.js';
import { acceptResponse, configurationResponse, transcriptResponse, transcriptUpdate, submissionResponse, responseStatusError, parseLine, deliver } from './responses.js';
import { readLines } from './stream.js';

/** Conversation requests and delivery, independent of observation. */
export class ConversationHttpTransport extends HttpTransport implements ConversationTransport, TranscriptTransport {
  protected override statusError = responseStatusError;

  async config() {
    return acceptResponse(configurationResponse, await this.get('/api/config'), '配置');
  }
  async transcript(id?: string, signal?: AbortSignal) {
    const snapshot = acceptResponse(transcriptResponse, await this.get(`/api/transcript${id ? `?id=${encodeURIComponent(id)}` : ''}`, signal), '消息');
    if (id && snapshot.id !== id) throw new HttpTransportError('contract', '返回了不同的消息集合。', 'TRANSCRIPT_MISMATCH');
    return snapshot;
  }
  async observeTranscript(id: string | undefined, accept: (frame: TranscriptFrame) => void, signal: AbortSignal): Promise<void> {
    const response = await this.send(`/api/transcript/observe${id ? `?id=${encodeURIComponent(id)}` : ''}`, { signal });
    if (!response.body) throw new HttpTransportError('contract', '服务未返回消息流。', 'MISSING_STREAM');
    for await (const line of readLines(response.body)) {
      const frame = acceptResponse(transcriptUpdate, parseLine(line), '消息流');
      if (frame.type === 'error') throw new HttpTransportError('remote', frame.error, frame.code);
      deliver(() => accept(frame), '消息变化');
    }
    if (!signal.aborted) throw new HttpTransportError('contract', '消息同步连接已结束。', 'INCOMPLETE_STREAM');
  }
  async submit(request: ConversationSubmissionRequest, receive: (snapshot: ConversationSubmissionSnapshot) => void, signal: AbortSignal): Promise<void> {
    await this.feedback('/api/run', request.submissionId, receive, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  }

  async follow(id: string, receive: (snapshot: ConversationSubmissionSnapshot) => void, signal: AbortSignal): Promise<void> {
    await this.feedback(`/api/submissions/${encodeURIComponent(id)}/follow`, id, receive, { signal });
  }

  async read(id: string, signal?: AbortSignal): Promise<ConversationSubmissionSnapshot> {
    const value = await this.get(`/api/submissions/${encodeURIComponent(id)}`, signal);
    return this.acceptSubmission(value, id);
  }

  private acceptSubmission(value: unknown, id: string): ConversationSubmissionSnapshot {
    const snapshot = acceptResponse(submissionResponse, value, '提交');
    if (snapshot.submissionId !== id) throw new HttpTransportError('contract', '提交反馈身份不一致。', 'SUBMISSION_MISMATCH');
    return snapshot;
  }

  private async feedback(path: string, id: string, receive: (snapshot: ConversationSubmissionSnapshot) => void, init: RequestInit): Promise<void> {
    let response: Response;
    try {
      response = await this.send(path, init);
    } catch (error) {
      // A known rejection is a formal cumulative fact even when HTTP uses a non-2xx status.
      if (!(error instanceof HttpError) || !submissionResponse.safeParse(error.body).success) throw error;
      const snapshot = this.acceptSubmission(error.body, id);
      deliver(() => receive(snapshot), '提交反馈');
      if (!snapshot.result && snapshot.integrity.status !== 'incomplete') throw new HttpTransportError('contract', 'HTTP 请求已结束，提交结果仍未确认。', 'INCOMPLETE_STREAM');
      return;
    }
    if (!response.body) throw new HttpTransportError('contract', '服务未返回提交反馈流。', 'MISSING_STREAM');
    for await (const line of readLines(response.body)) {
      const snapshot = this.acceptSubmission(parseLine(line), id);
      deliver(() => receive(snapshot), '提交反馈');
      if (snapshot.result || snapshot.integrity.status === 'incomplete') return;
    }
    if (!init.signal?.aborted) throw new HttpTransportError('contract', '提交反馈流提前结束，远端结果仍未确认。', 'INCOMPLETE_STREAM');
  }
}
