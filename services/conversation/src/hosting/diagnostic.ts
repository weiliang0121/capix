import { ModelCompletionIncomplete } from '../model/incomplete.js';
import { ProviderError } from '@weiliang0121/capix-model-provider';
import { ConversationArchiveFull } from './archive-admission.js';

/** Never print arbitrary causes, model payloads, headers or credential-bearing configuration. */
export function failureLabel(error: unknown): string {
  if (error instanceof ModelCompletionIncomplete) return `${error.code}: ${error.message}`;
  if (error instanceof ProviderError) return `${error.code}: ${error.message}`;
  if (error instanceof ConversationArchiveFull) return `${error.code}: ${error.message}`;
  if (error instanceof Error) {
    const code = Reflect.get(error, 'code');
    return typeof code === 'string' && /^[A-Z_]+$/.test(code) ? code : error.name;
  }
  return 'unknown failure';
}
