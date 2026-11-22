/** Default resolver branch for hosts that supply their own engine primitives. */
export const systemInspection = undefined;

export function systemRandomUUID(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID !== 'function') throw new Error('CAPiX requires crypto.randomUUID() or an installed UUID generator on this platform');
  return crypto.randomUUID();
}
