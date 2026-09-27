import { isError } from 'es-toolkit/predicate';

export function errorMessage(error: unknown): string {
  return isError(error) ? error.message : String(error);
}
