import { SessionConnectionError, type SessionTransport } from '@capix/client-runtime';
import type { ConversationSubmissionFrame, ConversationSubmissionRequest } from '@capix/protocol';
import { ConversationHttpTransport } from './conversation.js';
import { HttpError, HttpTransportError } from './errors.js';
import { acceptResponse } from './responses.js';
import { acceptCallDetail, inspectionResponse, sessionResponse } from './session-responses.js';

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
