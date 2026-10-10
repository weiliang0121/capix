import { RuntimeError } from '../errors/error.js';

/** Recording failed; repeating work cannot repair its recording. */
export class RecordingError extends RuntimeError {
  constructor(cause: unknown) {
    super('RECORDING_FAILED', cause instanceof Error ? cause.message : '运行记录登记失败。', undefined, { cause });
  }
}

export function writeRecord<Result>(write: () => Result): Result {
  try {
    return write();
  } catch (error) {
    throw error instanceof RecordingError ? error : new RecordingError(error);
  }
}
