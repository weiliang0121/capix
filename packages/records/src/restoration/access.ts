/** Package-private hydration capabilities. Restoring facts never replays record operations. */
export const restoreContent = Symbol('restoreContent');
export const restoreStatus = Symbol('restoreStatus');
export const sealHistorical = Symbol('sealHistorical');
