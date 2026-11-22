import { systemRandomUUID } from '#engine';

type UUID = `${string}-${string}-${string}-${string}-${string}`;
let installed: (() => string) | undefined;
let used = false;

/** Configure the host before the first framework identity is allocated. */
export function installRandomUUID(generate: () => string): void {
  if (typeof generate !== 'function') throw new TypeError('The UUID generator must be a function');
  if (installed === generate) return;
  if (installed || used) throw new Error('The CAPiX UUID generator is already fixed');
  installed = generate;
}

export function randomUUID(): UUID {
  const id = (installed ?? systemRandomUUID)();
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new TypeError('The UUID generator must return a version 4 UUID');
  used = true;
  return id as UUID;
}
