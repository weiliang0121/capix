import { SessionConnectionError, type SessionTransport } from '@capix/client-runtime';
import type { ConversationSubmissionFrame, ConversationSubmissionRequest, ConversationRecoveryRequest } from '@capix/protocol';
import { ConversationHttpTransport } from './conversation.js';
import { HttpError, HttpTransportError } from './errors.js';
import { acceptResponse, parseLine } from './responses.js';
import { acceptCallDetail, inspectionResponse, sessionResponse, recoveriesResponse, recordingResponse } from './session-responses.js';

/** Single-conversation service endpoints; submissions share the established wire receiver. */
export class SessionHttpTransport extends ConversationHttpTransport implements SessionTransport {
  async session(signal?: AbortSignal) {
    return acceptResponse(sessionResponse, await this.get('/api/session', signal), '服务');
  }
  async inspection(signal?: AbortSignal) {
    return acceptResponse(inspectionResponse, await this.get('/api/inspection', signal), '内容与记录');
  }
  async call(id: string, signal?: AbortSignal) {
    return acceptCallDetail(await this.get(`/api/calls/${encodeURIComponent(id)}`, signal), id);
  }
  async recoveries(signal?: AbortSignal) {
    return acceptResponse(recoveriesResponse, await this.get('/api/recoveries', signal), '可恢复断点');
  }
  async recording(signal?: AbortSignal) {
    return acceptResponse(recordingResponse, await this.get('/api/recording', signal), '记录采集');
  }
  startRecording(signal?: AbortSignal) {
    return this.changeRecording('start', {}, signal);
  }
  stopRecording(recorderId: string, signal?: AbortSignal) {
    return this.changeRecording('stop', { recorderId }, signal);
  }
  clearRecording(recorderId: string, signal?: AbortSignal) {
    return this.changeRecording('clear', { recorderId }, signal);
  }
  private async changeRecording(action: 'start' | 'stop' | 'clear', body: { readonly recorderId?: string }, signal?: AbortSignal) {
    const response = await this.send(`/api/recording/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    const state = acceptResponse(recordingResponse, parseLine(await response.text()), '记录采集');
    const valid = action === 'start' ? state.status === 'recording' : action === 'clear' ? state.status === 'idle' : (state.status === 'stopping' || state.status === 'stopped') && state.recorderId === body.recorderId;
    if (!valid) throw new HttpTransportError('contract', '记录控制结果与请求不一致。', 'RECORDING_MISMATCH');
    return state;
  }
  resume(request: ConversationRecoveryRequest, receive: (frame: ConversationSubmissionFrame) => void, signal: AbortSignal) {
    return connection(() => this.feedback('/api/resume', request.submissionId, receive, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal }, request.conversationId), signal);
  }
  override submit(request: ConversationSubmissionRequest, receive: (frame: ConversationSubmissionFrame) => void, signal: AbortSignal) {
    return connection(() => super.submit(request, receive, signal), signal);
  }
  override follow(id: string, receive: (frame: ConversationSubmissionFrame) => void, signal: AbortSignal) {
    return connection(() => super.follow(id, receive, signal), signal);
  }
  override read(id: string, signal?: AbortSignal) {
    return connection(() => super.read(id, signal), signal);
  }
}

async function connection<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (signal?.aborted) throw error;
    // Callback failures are already marked delivery failures by the wire receiver.
    // Only a known connection failure permits bounded GET/follow recovery, never POST replay.
    if (error instanceof TypeError || (error instanceof HttpError && error.phase === 'status' && [408, 429, 500, 502, 503, 504].includes(error.response.status)) || (error instanceof HttpTransportError && error.kind === 'contract' && error.code === 'INCOMPLETE_STREAM')) throw new SessionConnectionError(error.message, { cause: error });
    throw error;
  }
}
