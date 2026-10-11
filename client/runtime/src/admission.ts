import type { ConversationAdmission } from '@capix/protocol';
import { isPlainObject } from 'es-toolkit/predicate';

/** Admission is separate from an old submission's outcome, even on custom transports. */
export function validAdmission(value: unknown): value is ConversationAdmission {
  if (!isPlainObject(value) || typeof value.transcriptId !== 'string' || !value.transcriptId.length) return false;
  if (value.status === 'ready' || value.status === 'busy') return true;
  return value.status === 'unavailable' && isPlainObject(value.error) && typeof value.error.code === 'string' && value.error.code.length > 0 && typeof value.error.message === 'string';
}
