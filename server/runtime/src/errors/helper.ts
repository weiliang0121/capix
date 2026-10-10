import type { RuntimeErrorValue } from '@capix/protocol';
import { ErrorTraversal, formatLimits } from './traversal.js';
import { formatError } from './format.js';

/** Diagnostic formatting. Neither creates records or changes execution state. */
export class RuntimeErrorHelper {
  static format(error: unknown): RuntimeErrorValue {
    return formatError(error, new ErrorTraversal(formatLimits));
  }
}
