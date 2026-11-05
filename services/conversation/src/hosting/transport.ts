import { setImmediate } from 'node:timers/promises';

/** Node host scheduling policy, not a retry or a guarantee that pooled sockets remain open. */
export function createYieldingFetch(fetcher: typeof fetch = globalThis.fetch): typeof fetch {
  if (typeof fetcher !== 'function') throw new TypeError('A fetch transport is required');
  return async (input, init) => {
    // Fix the top-level request options across the yield, especially signal.
    // Headers, body and Request objects remain borrowed, as host-owned values.
    const options = init === undefined ? undefined : { ...init };
    // An explicit init signal (including null) overrides Request.signal, as in fetch.
    const supplied = options?.signal;
    const signal = supplied === undefined && input instanceof Request ? input.signal : supplied;
    signal?.throwIfAborted();
    // Leave the current promise chain so Node can service pending I/O. The caller's
    // total timeout remains active; dispatch must not follow an intervening abort.
    await setImmediate();
    signal?.throwIfAborted();
    return fetcher(input, options);
  };
}
