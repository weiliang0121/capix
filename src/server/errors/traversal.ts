export const formatLimits = { depth: 12, values: 2048, entries: 100, string: 16384 } as const;

/** State shared by all branches of one conversion; contains no error or record semantics. */
export class ErrorTraversal {
  private readonly ancestors = new Set<object>();
  private remaining: number;

  constructor(private readonly limits: { depth: number; values: number }) {
    this.remaining = limits.values;
  }

  consume(depth: number): boolean {
    return depth <= this.limits.depth && this.remaining-- > 0;
  }

  contains(value: object): boolean {
    return this.ancestors.has(value);
  }

  within<T>(value: object, convert: () => T): T {
    this.ancestors.add(value);
    try {
      return convert();
    } finally {
      this.ancestors.delete(value);
    }
  }
}
