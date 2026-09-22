type Result<T> = T | Promise<T>;

/** Stateless logic. Each invocation keeps its values in local variables. */
export interface Operation<Input, Prepared, Raw, Output> {
  readonly before: (input: Input) => Result<Prepared>;
  readonly commit: (prepared: Prepared) => Result<Raw>;
  // The original input is explicit when acceptance depends on it (e.g. index bounds).
  readonly after: (raw: Raw, input: Input) => Result<Output>;
}

export function identity<T>(value: T): T {
  return value;
}

export async function runOperation<I, P, R, O>(operation: Operation<I, P, R, O>, input: I): Promise<O> {
  const prepared = await operation.before(input);
  const raw = await operation.commit(prepared);
  return operation.after(raw, input);
}
