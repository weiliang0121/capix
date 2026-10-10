/** Deterministic browser frames for the application binding's publication boundary. */
export function installFrames(t) {
  const previousRequest = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame');
  const previousCancel = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  const callbacks = new Map();
  let sequence = 0;
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    value: (callback) => {
      const id = ++sequence;
      callbacks.set(id, callback);
      return id;
    },
  });
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: (id) => callbacks.delete(id) });
  t.after(() => {
    if (previousRequest) Object.defineProperty(globalThis, 'requestAnimationFrame', previousRequest);
    else delete globalThis.requestAnimationFrame;
    if (previousCancel) Object.defineProperty(globalThis, 'cancelAnimationFrame', previousCancel);
    else delete globalThis.cancelAnimationFrame;
  });
  return {
    get pending() {
      return callbacks.size;
    },
    async flush() {
      await new Promise((resolve) => setImmediate(resolve));
      const scheduled = [...callbacks.values()];
      callbacks.clear();
      for (const callback of scheduled) callback(0);
    },
  };
}
