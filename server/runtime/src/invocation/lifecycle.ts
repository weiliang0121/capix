/** Specialization of the shared invocation boundary; no work is executed here. */
export interface InvocationLifecycle<Handle, Output> {
  begin(): Handle;
  succeed(handle: Handle, output: Output): void;
  fail(handle: Handle, error: unknown): void;
}
