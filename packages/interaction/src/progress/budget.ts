import type { InteractionProgressBudgetLimits } from './types.js';

export function positiveLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
}

/** Accounting shared by retained process feedback; it does not limit external execution. */
export class ProgressBudget {
  readonly #maxBytes: number;
  readonly #maxReaders: number;
  #bytes = 0;
  #readers = 0;

  constructor(limits: InteractionProgressBudgetLimits = {}) {
    this.#maxBytes = positiveLimit(limits.maxBytes ?? 32 * 1024 * 1024, 'Progress budget maxBytes');
    this.#maxReaders = positiveLimit(limits.maxReaders ?? 256, 'Progress budget maxReaders');
  }

  reserveBytes(bytes: number): boolean {
    positiveLimit(bytes, 'Reserved progress bytes');
    if (bytes > this.#maxBytes - this.#bytes) return false;
    this.#bytes += bytes;
    return true;
  }

  releaseBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.#bytes) throw new RangeError('Invalid progress byte release');
    this.#bytes -= bytes;
  }

  reserveReader(): boolean {
    if (this.#readers >= this.#maxReaders) return false;
    this.#readers += 1;
    return true;
  }

  releaseReader(): void {
    if (this.#readers === 0) throw new RangeError('Invalid progress reader release');
    this.#readers -= 1;
  }
}
