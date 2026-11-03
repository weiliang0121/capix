import type { ConversationCallDetail, ConversationInspection, ConversationServiceInfo } from '@capix/protocol';
import type { ConversationTransport, TranscriptTransport } from '../transport.js';

/** The single-conversation service needs neither model settings nor a conversation directory. */
export interface SessionTransport extends Pick<ConversationTransport, 'read' | 'cancel' | 'submit' | 'follow'>, TranscriptTransport {
  session(signal?: AbortSignal): Promise<ConversationServiceInfo>;
  inspection(signal?: AbortSignal): Promise<ConversationInspection>;
  call(id: string, signal?: AbortSignal): Promise<ConversationCallDetail>;
}

/** Only transport-confirmed interruptions permit bounded follow, never another POST. */
export class SessionConnectionError extends Error {
  readonly name = 'SessionConnectionError';
}
