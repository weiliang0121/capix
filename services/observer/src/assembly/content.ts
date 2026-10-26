import { RuntimeError } from '@capix/contracts';
import { Transcript } from '@capix/transcript';
import { Memories } from '@capix/memory';
import { ConversationContent } from '@capix/observer-content';
import type { Message } from '@capix/protocol';
import type { SqliteObserverStore } from '../persistence/store.js';

/** Resolve content ownership and durable identity before installing a running environment. */
export function loadConversationContent(messages: readonly Message[], options: { readonly content?: ConversationContent; readonly persistence?: SqliteObserverStore; readonly conversationId?: string }): ConversationContent {
  const { content, persistence, conversationId } = options;
  if (content) {
    if (content.closed) throw new RuntimeError('SERVICE_CLOSED', '对话内容同步已关闭。');
    if (persistence) {
      const identity = conversationId ? persistence.contentIdentity(conversationId) : undefined;
      if (!identity || identity.transcriptId !== content.transcript.id || identity.memoriesId !== content.memories.id || content.memories.transcript !== content.transcript) throw new Error('Content belongs to another conversation');
    }
    return content;
  }
  let saved = persistence?.loadContent(conversationId);
  if (saved && messages.length) throw new Error('Cannot append startup messages to restored content');
  if (persistence && !saved) {
    const transcript = new Transcript(messages);
    const memories = new Memories(transcript);
    saved = { version: 1, transcript: transcript.exportState(), memories: memories.exportState() };
    persistence.initialize(saved);
  }
  // Fresh memory-only messages are appended after recording is installed.
  return new ConversationContent({ saved, messages: persistence ? messages : [], persistence });
}
