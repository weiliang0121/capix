export function receptionChildId(_owner: symbol): string {
  throw new Error('Fixed entity operations require an active direct-child reception. Pass an explicit direct-child reception permit on this platform.');
}

export async function receive<Value>(_owner: symbol, _childContextId: string, work: () => Promise<Value>): Promise<Value> {
  return work();
}
