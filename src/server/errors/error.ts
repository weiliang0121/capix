/** An expected failure with an explicit code and optional detail. */
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
