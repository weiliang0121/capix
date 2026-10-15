import { mock } from 'node:test';
import { RuntimeBinder } from '@capix/server-runtime';

/** Configure a host-created declaration before its synchronous binding, without adding a production hook. */
export function withRuntimeDefinition(configure, initialize) {
  if (!configure) return initialize();
  const bind = RuntimeBinder.prototype.bind;
  const patched = mock.method(RuntimeBinder.prototype, 'bind', function (definition, options) {
    configure(definition);
    return bind.call(this, definition, options);
  });
  try {
    return initialize();
  } finally {
    patched.mock.restore();
  }
}
