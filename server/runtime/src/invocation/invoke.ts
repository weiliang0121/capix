import type { InvocationLifecycle } from './lifecycle.js';

/** Only work failures enter fail(); a failed result registration is propagated separately. */
export async function invoke<H, O>(lifecycle: InvocationLifecycle<H, O>, execute: (handle: H) => O | Promise<O>): Promise<O> {
  const handle = lifecycle.begin();
  let output: O;
  try {
    output = await execute(handle);
  } catch (error) {
    try {
      lifecycle.fail(handle, error);
    } catch (registrationError) {
      throw new AggregateError([error, registrationError], 'Work failed and failure registration also failed', { cause: error });
    }
    throw error;
  }
  lifecycle.succeed(handle, output);
  return output;
}
