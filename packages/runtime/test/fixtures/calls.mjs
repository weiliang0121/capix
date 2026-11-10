// Fixture-only capture. Production invocations never expose record handles.
const calls = new WeakMap();
export function rememberCall(invocation) {
  calls.set(invocation.context, invocation);
  return invocation;
}
export function callFor(context) {
  const invocation = calls.get(context);
  if (!invocation) throw new Error('Test fixture has not captured this invocation');
  return invocation;
}
export function recordFor(context) {
  return callFor(context).record;
}
