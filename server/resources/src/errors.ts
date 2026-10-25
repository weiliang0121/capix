/** Revoked access cannot be recovered by a business result receiver. */
export class ResourceAccessClosed extends Error {
  constructor(message = 'Resource access window is closed') {
    super(message);
    this.name = 'ResourceAccessClosed';
  }
}

/** A required host port failed its contract, independently of the resource method outcome. */
export class ResourcePortError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ResourcePortError';
  }
}
