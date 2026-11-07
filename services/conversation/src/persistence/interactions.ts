import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { Interaction, type InteractionState, type InteractionPersistence, type InteractionCommit } from '@capix/interaction';
import type { ModelRequest, ModelReply } from '@capix/model-provider';
import { z } from 'zod';
import { CompletionInteraction } from '../model/completion-contract.js';
import { RecoveryConflict, requireIdentity, requireRevision, type RecoveryTransaction } from './recovery.js';

export interface ConversationInteractions extends InteractionPersistence<ModelRequest, ModelReply> {
  read(id: string): InteractionState<ModelRequest, ModelReply> | undefined;
}

const maxBytes = 8 * 1024 * 1024;
const rowSchema = z.strictObject({ id: z.string().min(1), revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), body: z.string() });

/** Only complete model requests and replies are durable; preview fragments have no table. */
export class SqliteInteractions implements ConversationInteractions {
  constructor(
    private readonly database: DatabaseSync,
    private readonly transaction: RecoveryTransaction,
  ) {}

  create(state: InteractionState<ModelRequest, ModelReply>): undefined {
    const fixed = capture(state);
    if (fixed.revision !== 0 || fixed.delivery !== 'prepared') throw new TypeError('A new interaction must be prepared at revision zero');
    this.transaction('interaction.create', () => {
      if (this.database.prepare('SELECT 1 FROM completion_interactions WHERE id = ?').get(fixed.id)) throw conflict('Interaction identity has already been saved');
      this.database.prepare('INSERT INTO completion_interactions VALUES (?, ?, ?)').run(fixed.id, fixed.revision, JSON.stringify(fixed));
    });
    return undefined;
  }

  commit(change: InteractionCommit<ModelRequest, ModelReply>): undefined {
    requireRevision(change.expectedRevision);
    const fixed = capture(change.state);
    this.transaction('interaction.commit', () => {
      const current = this.readCurrent(fixed.id);
      if (!current || current.revision !== change.expectedRevision || fixed.revision !== change.expectedRevision + 1) throw conflict('Interaction revision does not match');
      if (current.contract !== fixed.contract || !isDeepStrictEqual(current.request, fixed.request)) throw conflict('Interaction contract and original request cannot change');
      if ((current.delivery === 'started' && fixed.delivery !== 'started') || (current.feedback && !isDeepStrictEqual(current.feedback, fixed.feedback)) || (current.failure && !isDeepStrictEqual(current.failure, fixed.failure))) throw conflict('Existing interaction facts cannot be replaced');
      const result = this.database.prepare('UPDATE completion_interactions SET revision = ?, body = ? WHERE id = ? AND revision = ?').run(fixed.revision, JSON.stringify(fixed), fixed.id, change.expectedRevision);
      if (result.changes !== 1) throw new Error('Interaction changed during exclusive commit');
    });
    return undefined;
  }

  read(id: string): InteractionState<ModelRequest, ModelReply> | undefined {
    requireIdentity(id);
    return this.transaction('interaction.read', () => this.readCurrent(id));
  }

  private readCurrent(id: string): InteractionState<ModelRequest, ModelReply> | undefined {
    const value = this.database.prepare('SELECT * FROM completion_interactions WHERE id = ?').get(id);
    if (!value) return undefined;
    const row = rowSchema.parse(value);
    if (Buffer.byteLength(row.body, 'utf8') > maxBytes) throw new Error('Persisted interaction exceeds its byte limit');
    const raw: InteractionState = JSON.parse(row.body);
    const state = capture(raw);
    if (state.id !== row.id || state.revision !== row.revision) throw new Error('Persisted interaction differs from its row');
    return state;
  }
}

function capture(state: InteractionState): InteractionState<ModelRequest, ModelReply> {
  // Public restoration validates and freezes plain data without starting a sender.
  const fixed = Interaction.restore(state, { contract: CompletionInteraction }).exportState();
  if (!isDeepStrictEqual(state, fixed)) throw new TypeError('Interaction contains unsupported fields or noncanonical values');
  if (Buffer.byteLength(JSON.stringify(fixed), 'utf8') > maxBytes) throw new TypeError('Interaction persistence exceeds its byte limit');
  return fixed;
}

function conflict(message: string): RecoveryConflict {
  return new RecoveryConflict('INTERACTION_PERSISTENCE_CONFLICT', message);
}
