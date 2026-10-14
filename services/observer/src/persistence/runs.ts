import type { DatabaseSync } from 'node:sqlite';
import { isEqual } from 'es-toolkit';
import { RuntimeError } from '@capix/server-runtime';
import { copyConversationCheckpointRun, type ConversationCheckpointRun, type ConversationCheckpointRuns } from '../conversation/checkpoints.js';

/** Small host-owned association, using the same exclusive database as content and checkpoints. */
export class SqliteConversationCheckpointRuns implements ConversationCheckpointRuns {
  constructor(private readonly database: DatabaseSync) {
    database.exec('CREATE TABLE IF NOT EXISTS conversation_checkpoint_runs (root_context_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), execution_context_id TEXT NOT NULL UNIQUE, body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS conversation_checkpoint_runs_conversation ON conversation_checkpoint_runs(conversation_id);');
  }
  register(run: ConversationCheckpointRun): void {
    const fixed = copyConversationCheckpointRun(run);
    const current = this.database.prepare('SELECT body FROM conversation_checkpoint_runs WHERE root_context_id = ?').get(fixed.rootContextId);
    if (current) {
      if (!isEqual(decode(current.body), fixed)) throw new RuntimeError('CHECKPOINT_CONFLICT', 'Conversation checkpoint construction basis cannot change');
      return;
    }
    const identity = this.database.prepare('SELECT transcript_id, memories_id FROM conversations WHERE id = ?').get(fixed.conversationId);
    if (!identity || identity.transcript_id !== fixed.transcript.transcriptId || identity.memories_id !== fixed.memories.id) throw new RuntimeError('CHECKPOINT_CONFLICT', 'Checkpoint content belongs to another conversation');
    this.database.prepare('INSERT INTO conversation_checkpoint_runs(root_context_id, conversation_id, execution_context_id, body) VALUES (?, ?, ?, ?)').run(fixed.rootContextId, fixed.conversationId, fixed.executionContextId, JSON.stringify(fixed));
  }
  read(conversationId: string, rootContextId: string): ConversationCheckpointRun | undefined {
    const row = this.database.prepare('SELECT root_context_id, conversation_id, execution_context_id, body FROM conversation_checkpoint_runs WHERE conversation_id = ? AND root_context_id = ?').get(conversationId, rootContextId);
    return row ? checked(row) : undefined;
  }
  list(conversationId: string): readonly ConversationCheckpointRun[] {
    return Object.freeze(this.database.prepare('SELECT root_context_id, conversation_id, execution_context_id, body FROM conversation_checkpoint_runs WHERE conversation_id = ? ORDER BY rowid').all(conversationId).map(checked));
  }
}
function decode(value: unknown): ConversationCheckpointRun {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 8 * 1024 * 1024) throw new Error('Invalid conversation checkpoint construction basis');
  return copyConversationCheckpointRun(JSON.parse(value));
}
function checked(row: Record<string, unknown>): ConversationCheckpointRun {
  const run = decode(row.body);
  if (run.rootContextId !== row.root_context_id || run.conversationId !== row.conversation_id || run.executionContextId !== row.execution_context_id) throw new Error('Stored conversation checkpoint identity does not match');
  return run;
}
