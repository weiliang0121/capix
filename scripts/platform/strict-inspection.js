(function () {
  function descriptorClassifier(isProxy, isHostObject) {
    return (value) => {
      if (isProxy?.(value)) return 'proxy';
      if (isHostObject?.(value)) return 'unsupported';

      const array = Array.isArray(value);
      const prototype = Object.getPrototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return 'unsupported';
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) return 'accessor';
      }
      if (array) return 'array';
      return prototype === null ? 'null-record' : 'record';
    };
  }

  function instrumentedProxy(target, effects, throwing = false) {
    const handler = {};
    const trap =
      (key) =>
      (...args) => {
        effects.push(key);
        if (throwing) throw new Error('Trap executed');
        return Reflect[key](...args);
      };
    for (const key of ['get', 'getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor', 'has', 'set', 'defineProperty', 'deleteProperty', 'isExtensible', 'preventExtensions', 'setPrototypeOf']) {
      handler[key] = trap(key);
    }
    return new Proxy(target, handler);
  }

  function recordWithGetter(effects) {
    return Object.defineProperty({}, 'value', {
      enumerable: true,
      get() {
        effects.push('getter');
        return 1;
      },
    });
  }

  function revoked(target) {
    const pair = Proxy.revocable(target, {});
    pair.revoke();
    return pair.proxy;
  }

  function observe(operation) {
    try {
      return operation();
    } catch {
      return 'threw';
    }
  }

  function inspectionCases() {
    return [
      { name: 'record', expected: 'record', make: () => ({ value: 1 }) },
      { name: 'frozen record', expected: 'record', make: () => Object.freeze({ value: 1 }) },
      { name: 'null-prototype record', expected: 'null-record', make: () => Object.assign(Object.create(null), { value: 1 }) },
      { name: 'array', expected: 'array', make: () => [1] },
      { name: 'instance', expected: 'unsupported', make: () => new Date(0) },
      { name: 'record getter', expected: 'accessor', make: recordWithGetter },
      { name: 'array getter', expected: 'accessor', make: (effects) => Object.defineProperty([], '0', Object.getOwnPropertyDescriptor(recordWithGetter(effects), 'value')) },
      { name: 'hidden getter', expected: 'accessor', make: (effects) => Object.defineProperty({}, 'hidden', { ...Object.getOwnPropertyDescriptor(recordWithGetter(effects), 'value'), enumerable: false }) },
      { name: 'symbol getter', expected: 'accessor', make: (effects) => Object.defineProperty({}, Symbol('hidden'), Object.getOwnPropertyDescriptor(recordWithGetter(effects), 'value')) },
      { name: 'transparent record proxy', expected: 'proxy', make: () => new Proxy({ value: 1 }, {}) },
      { name: 'transparent array proxy', expected: 'proxy', make: () => new Proxy([1], {}) },
      { name: 'forwarding record proxy', expected: 'proxy', make: (effects) => instrumentedProxy({ value: 1 }, effects) },
      { name: 'forwarding array proxy', expected: 'proxy', make: (effects) => instrumentedProxy([1], effects) },
      { name: 'proxy with throwing traps', expected: 'proxy', make: (effects) => instrumentedProxy({ value: 1 }, effects, true) },
      { name: 'nested proxies', expected: 'proxy', make: (effects) => instrumentedProxy(instrumentedProxy({ value: 1 }, effects), effects) },
      { name: 'revoked record proxy', expected: 'proxy', make: () => revoked({}) },
      { name: 'revoked array proxy', expected: 'proxy', make: () => revoked([]) },
    ];
  }

  function run(classify, native = {}) {
    const cases = inspectionCases();
    if (native.hostObject !== undefined) cases.push({ name: 'JSI HostObject', expected: 'unsupported', make: () => native.hostObject });

    const failures = [];
    for (const { name, expected, make } of cases) {
      const effects = [];
      const value = make(effects);
      const before = native.hostEffects?.() ?? 0;
      const actual = observe(() => classify(value));
      const hostEffects = (native.hostEffects?.() ?? 0) - before;
      if (actual !== expected || effects.length !== 0 || hostEffects !== 0) failures.push({ name, expected, actual, effects, hostEffects });
    }
    return { total: cases.length, failures };
  }

  function observeNativeMethods(probe) {
    const effects = [];
    const getter = recordWithGetter(effects);
    const proxy = instrumentedProxy({ value: 1 }, effects);
    const record = {};
    return [
      ['getProperty on accessor', 'property', getter],
      ['getPrototype on proxy', 'prototype', proxy],
      ['getPropertyNames on proxy', 'names', proxy],
      ['hasNativeState on proxy', 'native-state', proxy],
      ['hasNativeState on record', 'native-state', record],
      ['setNativeState on proxy', 'set-native-state', proxy],
      ['setNativeState on record', 'set-native-state', record],
      ['hasNativeState after writing to record', 'native-state', record],
    ].map(([name, method, value]) => {
      const actual = observe(() => probe(method, value));
      return { name, actual, effects: effects.splice(0) };
    });
  }

  function observeHermesBrands(native) {
    const effects = [];
    const error = new Error('test');
    Object.setPrototypeOf(error, null);
    const promise = Promise.resolve(1);
    const copy = Object.create(Object.getPrototypeOf(promise), Object.getOwnPropertyDescriptors(promise));
    const samples = [
      ['record', {}],
      ['genuine Error with null prototype', error],
      ['Error.prototype forgery', Object.create(Error.prototype)],
      ['throwing proxy of Error', instrumentedProxy(error, effects, true)],
      ['revoked proxy of Error', revoked(error)],
      ['JSI HostObject', native.hostObject],
      ['Promise', promise],
      ['copy of Promise prototype and own descriptors', copy],
    ];
    const hostEffectsBefore = native.hostEffects();
    const rows = samples.map(([name, sample]) => ({
      name,
      errorBrand: Error.isError(sample),
      id: native.probe('unique-id', sample),
    }));
    return { rows, effects, hostEffects: native.hostEffects() - hostEffectsBefore, promiseCopyPassesInstanceof: copy instanceof Promise };
  }

  return { descriptorClassifier, inspectionCases, run, observeNativeMethods, observeHermesBrands };
})();
