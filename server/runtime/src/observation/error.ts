export class ObservationError extends Error {
  readonly code = 'OBSERVATION_FAILED';
  constructor(cause: unknown) {
    super('Observation failed', { cause });
    this.name = 'ObservationError';
  }
}
