import { RuntimeError } from '../errors/error.js';

/** The source has already changed. Retrying the work would repeat that change. */
export class ChangeCaptureError<E = unknown> extends RuntimeError {
  constructor(
    readonly event: E,
    cause: unknown,
  ) {
    super('CHANGE_CAPTURE_FAILED', '变化已落实，但捕获失败；不得通过重做工作补偿。', undefined, { cause });
  }
}
