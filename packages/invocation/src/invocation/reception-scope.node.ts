import { AsyncLocalStorage } from 'node:async_hooks';

interface ReceptionScope {
  readonly owner: symbol;
  readonly childContextId: string;
  readonly parent: ReceptionScope | undefined;
  active: boolean;
}

// A single carrier avoids adding an async hook for every parent invocation.
const receptions = new AsyncLocalStorage<ReceptionScope>();

export function receptionChildId(owner: symbol): string {
  let reception = receptions.getStore();
  while (reception && reception.owner !== owner) reception = reception.parent;
  // An expired matching scope cannot borrow an older scope's authority.
  if (!reception?.active) throw new Error('Fixed entity operations require an active direct-child reception');
  return reception.childContextId;
}

export async function receive<Value>(owner: symbol, childContextId: string, work: () => Promise<Value>): Promise<Value> {
  const reception: ReceptionScope = { owner, childContextId, active: true, parent: receptions.getStore() };
  try {
    return await receptions.run(reception, work);
  } finally {
    reception.active = false;
  }
}
