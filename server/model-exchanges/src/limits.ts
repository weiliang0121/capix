/** Operational budgets may be lower than the supported persistence limits. */
export const defaultModelExchangeLimits = Object.freeze({ entries: 10_000, bytes: 64 * 1024 * 1024 });

/** Persistence adapters must support every collection allowed by these ceilings. */
export const maximumModelExchangeLimits = Object.freeze({ entries: 100_000, bytes: 128 * 1024 * 1024 });
export const maximumModelExchangeEntryBytes = 8 * 1024 * 1024;
