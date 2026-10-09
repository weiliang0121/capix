export class ObservationError extends Error {
  readonly code = 'OBSERVATION_FAILED';
  constructor(cause: unknown) {
    super('Observation failed', { cause });
    this.name = 'ObservationError';
  }
}

export function combineFaults(faults: readonly unknown[]): unknown | undefined {
  if (faults.length === 0) return undefined;
  if (faults.length === 1) return faults[0];
  return new AggregateError(faults, 'Multiple publication failures', { cause: faults[0] });
}
