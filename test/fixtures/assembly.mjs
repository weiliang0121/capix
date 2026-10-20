import { mock } from 'node:test';
import { CallableBinder } from '@capix/server-runtime';

/** Configure a host-created declaration before its synchronous binding, without adding a production hook. */
export function withRuntimeDefinition(configure, initialize) {
  if (!configure) return initialize();
  const bind = CallableBinder.prototype.bind;
  const patched = mock.method(CallableBinder.prototype, 'bind', function (definition, options) {
    configure(definition);
    return bind.call(this, definition, options);
  });
  try {
    return initialize();
  } finally {
    patched.mock.restore();
  }
}
