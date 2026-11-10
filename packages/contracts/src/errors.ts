/** Structured diagnostic. A code alone does not authorize business exception handling. */
export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}
