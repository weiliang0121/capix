/** The data shape delivered by the runtime. This is not a serializable-value codec. */
export type Stable<T> = T extends (...args: never[]) => unknown ? never : T extends readonly unknown[] ? (number extends T['length'] ? StableArray<Stable<T[number]>> : { readonly [Key in keyof T]: Stable<T[Key]> }) : T extends object ? { readonly [Key in keyof T]: Stable<T[Key]> } : T;

// An interface gives recursive data (for example JSON Schema) a stable comparison
// boundary; mapped tuples still preserve their exact length and element types.
export interface StableArray<T> extends ReadonlyArray<T> {}

/** Content bounds, independently of checkpoint and transport byte limits. */
export const stableValueLimits = Object.freeze({
  maxDepth: 64,
  maxExpandedValues: 1_000_000,
  maxTextUnits: 64 * 1024 * 1024,
});

export type StableValueErrorCode = 'UNSUPPORTED_VALUE' | 'CYCLIC_VALUE' | 'DEPTH_LIMIT' | 'VALUE_LIMIT' | 'TEXT_LIMIT' | 'INSPECTION_FAILED';

const messages: Readonly<Record<StableValueErrorCode, string>> = Object.freeze({
  UNSUPPORTED_VALUE: 'Stable values require ordinary data records, dense arrays and supported scalar values',
  CYCLIC_VALUE: 'Stable values cannot contain cycles',
  DEPTH_LIMIT: 'Stable value exceeds its depth limit',
  VALUE_LIMIT: 'Stable value exceeds its expanded value limit',
  TEXT_LIMIT: 'Stable value exceeds its expanded text limit',
  INSPECTION_FAILED: 'Stable value could not be inspected',
});

const errors = new WeakSet<object>();

/** Safe fixed diagnostics. Source values and thrown objects are never inspected or retained. */
export class StableValueError extends Error {
  readonly code: StableValueErrorCode;

  constructor(code: StableValueErrorCode) {
    const safeCode = typeof code === 'string' && Object.hasOwn(messages, code) ? code : 'INSPECTION_FAILED';
    super(messages[safeCode]);
    this.name = 'StableValueError';
    this.code = safeCode;
  }
}

interface Proof {
  readonly height: number;
  readonly values: number;
  readonly text: number;
}

interface Fixed {
  readonly value: unknown;
  readonly proof: Proof;
}

// Evidence is installed only for copies produced here. Object.freeze, a type
// assertion, or a lookalike record never grants this evidence to an input.
const trusted = new WeakMap<object, Proof>();

function fail(code: StableValueErrorCode): never {
  const error = Object.freeze(new StableValueError(code));
  errors.add(error);
  throw error;
}

function depthWithin(depth: number): void {
  if (depth > stableValueLimits.maxDepth) fail('DEPTH_LIMIT');
}

function textWithin(text: number): void {
  if (text > stableValueLimits.maxTextUnits) fail('TEXT_LIMIT');
}

/**
 * Isolate ordinary data once, then reuse certified immutable subgraphs.
 * Repeated edges count towards expanded content bounds even when their copies
 * are shared in memory. Neither sharing nor JavaScript object identity is a
 * durable contract. Null-prototype records retain their prototype.
 *
 * Inspection can execute Proxy metadata traps; this is not a Proxy sandbox or
 * an allocation bound for Reflect.ownKeys on an already enormous source.
 */
export function stableValue<T>(value: T | Stable<T>): Stable<T> {
  try {
    const memo = new WeakMap<object, Fixed>();
    const ancestors = new Set<object>();
    const completed: { readonly value: object; readonly proof: Proof }[] = [];

    const visit = (source: unknown, depth: number): Fixed => {
      depthWithin(depth);
      if (source === null || source === undefined || typeof source === 'boolean' || typeof source === 'string' || (typeof source === 'number' && Number.isFinite(source))) {
        const text = typeof source === 'string' ? source.length : 0;
        textWithin(text);
        return { value: source, proof: { height: 0, values: 1, text } };
      }
      if (typeof source !== 'object') fail('UNSUPPORTED_VALUE');
      if (ancestors.has(source)) fail('CYCLIC_VALUE');
      const prior = memo.get(source);
      if (prior) {
        depthWithin(depth + prior.proof.height);
        return prior;
      }
      const evidence = trusted.get(source);
      if (evidence) {
        depthWithin(depth + evidence.height);
        return { value: source, proof: evidence };
      }

      const array = Array.isArray(source);
      const prototype: unknown = Object.getPrototypeOf(source);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) fail('UNSUPPORTED_VALUE');
      const keys = Reflect.ownKeys(source);
      const entries = keys.length - (array ? 1 : 0);
      if (entries + 1 > stableValueLimits.maxExpandedValues) fail('VALUE_LIMIT');
      if (array) {
        const length = Object.getOwnPropertyDescriptor(source, 'length');
        if (!length || !Object.hasOwn(length, 'value') || length.value !== entries) fail('UNSUPPORTED_VALUE');
      }
      const owned: object = array ? [] : Object.create(prototype === null ? null : Object.prototype);
      let height = 0;
      let values = 1;
      let text = 0;
      let index = 0;
      ancestors.add(source);
      try {
        for (const key of keys) {
          if (typeof key !== 'string') fail('UNSUPPORTED_VALUE');
          if (array && key === 'length') continue;
          if (array && key !== String(index++)) fail('UNSUPPORTED_VALUE');
          const descriptor = Object.getOwnPropertyDescriptor(source, key);
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('UNSUPPORTED_VALUE');
          const child = visit(descriptor.value, depth + 1);
          height = Math.max(height, child.proof.height + 1);
          values += child.proof.values;
          if (values > stableValueLimits.maxExpandedValues) fail('VALUE_LIMIT');
          text += child.proof.text + (array ? 0 : key.length);
          textWithin(text);
          Object.defineProperty(owned, key, { value: child.value, enumerable: true });
        }
        Object.freeze(owned);
        const proof = Object.freeze({ height, values, text });
        const fixed = Object.freeze({ value: owned, proof });
        memo.set(source, fixed);
        completed.push({ value: owned, proof });
        return fixed;
      } finally {
        ancestors.delete(source);
      }
    };

    const result = visit(value, 0);
    // A failed sibling cannot publish a partial graph as trusted evidence.
    for (const entry of completed) trusted.set(entry.value, entry.proof);
    // Runtime validation above constructs exactly the recursive readonly data
    // shape. Unsupported objects throw instead of being asserted into that type.
    return result.value as Stable<T>;
  } catch (cause) {
    // WeakSet membership does not invoke getters or Proxy prototype traps.
    if (cause !== null && (typeof cause === 'object' || typeof cause === 'function') && errors.has(cause)) throw cause;
    throw new StableValueError('INSPECTION_FAILED');
  }
}
