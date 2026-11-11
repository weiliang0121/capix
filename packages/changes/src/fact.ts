import { stableValue, type Stable } from '@weiliang0121/capix-contracts';

const factBrand: unique symbol = Symbol('Fact');
declare const factTypeSignature: unique symbol;

/** An in-process carrier, not a delivery or checkpoint value. Read its fixed body through its exact FactType. */
export interface Fact {
  readonly name?: string;
  readonly [factBrand]: true;
}

interface FixedFact {
  readonly type: object;
  readonly value: unknown;
}

const facts = new WeakMap<Fact, FixedFact>();
const types = new WeakSet<object>();

/** An in-process source vocabulary, matched by object identity rather than name. */
export class FactType<Event> {
  declare readonly [factTypeSignature]: (event: Event) => Event;
  readonly name?: string;

  constructor(name?: string) {
    if (name !== undefined && typeof name !== 'string') throw new TypeError('FactType name must be a string or undefined');
    this.name = name;
    types.add(this);
    Object.freeze(this);
  }

  create(event: Event): Fact {
    if (!types.has(this)) throw new TypeError('Fact creation requires an authentic FactType');
    const value = stableValue(event);
    const fact: Fact = Object.freeze({ name: this.name, [factBrand]: true as const });
    facts.set(fact, { type: this, value });
    return fact;
  }

  match(fact: Fact, consume: (event: Stable<Event>) => void): boolean {
    if (!types.has(this)) throw new TypeError('Fact matching requires an authentic FactType');
    const fixed = facts.get(fact);
    if (!fixed) throw new TypeError('Fact matching requires an authentic Fact');
    if (fixed.type !== this) return false;
    // Only the exact token that fixed this body can recover its Event type.
    const returned: unknown = consume(fixed.value as Stable<Event>);
    if (returned !== null && (typeof returned === 'object' || typeof returned === 'function') && typeof (returned as { then?: unknown }).then === 'function') {
      void Promise.resolve(returned).catch(() => undefined);
      throw new TypeError('Fact consumers must complete synchronously');
    }
    return true;
  }
}
