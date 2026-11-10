/**
 * Array-compatible query port. Index/at access maps only the requested item;
 * enumeration and array methods pay for the items they actually read.
 * The port is not a detached snapshot. Already returned values may be snapshots.
 */
export function checkpointList<Value>(length: () => number, read: (index: number) => Value, validate: () => void): readonly Value[] {
  const index = (key: PropertyKey): number | undefined => {
    if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) return undefined;
    const value = Number(key);
    return Number.isSafeInteger(value) && value < 0xffffffff ? value : undefined;
  };
  const reject = () => {
    validate();
    throw new TypeError('Checkpoint reference queries are read-only');
  };
  return new Proxy<Value[]>([], {
    get(target, key, receiver) {
      validate();
      if (key === 'length') return length();
      const position = index(key);
      if (position !== undefined) return position < length() ? read(position) : undefined;
      return Reflect.get(target, key, receiver);
    },
    has(target, key) {
      validate();
      const position = index(key);
      return position === undefined ? Reflect.has(target, key) : position < length();
    },
    ownKeys() {
      validate();
      return [...Array.from({ length: length() }, (_, position) => String(position)), 'length'];
    },
    getOwnPropertyDescriptor(target, key) {
      validate();
      if (key === 'length') return { ...Reflect.getOwnPropertyDescriptor(target, key)!, value: length() };
      const position = index(key);
      if (position === undefined) return Reflect.getOwnPropertyDescriptor(target, key);
      return position < length() ? { configurable: true, enumerable: true, writable: false, value: read(position) } : undefined;
    },
    set: reject,
    deleteProperty: reject,
    defineProperty: reject,
    setPrototypeOf: reject,
    preventExtensions: reject,
  });
}
