import { RuntimeError } from '../errors/error.js';
import { Transcript } from '../transcript/transcript.js';
import type { MessageRef } from '../transcript/ref.js';
import { isObject } from '../value/object.js';

/** Request policy at the boundary; accepted messages enter one Transcript. */
export function acceptQuery(value: unknown): MessageRef {
  if (!isObject(value) || typeof value.query !== 'string' || !value.query.trim() || !Array.isArray(value.history) || value.history.length > 500) {
    throw new RuntimeError('INVALID_INPUT', '需要非空 query 和最多 500 条 user/assistant 历史消息。');
  }
  try {
    const transcript = new Transcript(value.history);
    transcript.append({ role: 'user', content: value.query });
    return transcript.ref(transcript.length - 1);
  } catch (error) {
    if (error instanceof TypeError) throw new RuntimeError('INVALID_INPUT', error.message);
    throw error;
  }
}
