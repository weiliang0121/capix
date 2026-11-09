import { RuntimeError } from '@weiliang0121/capix-contracts';

/** The source has already changed. Retrying the work would repeat that change. */
export class ChangeCaptureError<Event = unknown> extends RuntimeError {
  constructor(
    readonly event: Event,
    cause: unknown,
  ) {
    super('CHANGE_CAPTURE_FAILED', '变化已落实，但捕获失败；不得通过重做工作补偿。', undefined, { cause });
  }
}

export function combineFaults(faults: readonly unknown[]): unknown | undefined {
  if (faults.length === 0) return undefined;
  if (faults.length === 1) return faults[0];
  return new AggregateError(faults, 'Multiple publication failures', { cause: faults[0] });
}
