import { mock } from 'node:test';
import { CallableBinder } from '@capix/server-runtime';
import { GenerateAnswer } from '@capix/observer-service/conversation';

/** Test mutations use the same full replacement contract as author configuration. */
export function reconfigure(callable, changes) {
  const { name, label, source, callee, maxRounds, raises, output, run, exceptions, observation, checkpoint, receptions } = callable;
  callable.setDefinition({ name, label, source, callee, maxRounds, raises, output, run, exceptions, observation, checkpoint, receptions, ...changes });
  return callable;
}

/** Configure a host-created declaration before its synchronous binding, without adding a production hook. */
export function withRuntimeDefinition(configure, initialize) {
  if (!configure) return initialize();
  const bind = CallableBinder.prototype.bind;
  const patched = mock.method(CallableBinder.prototype, 'bind', function (definition, options) {
    const conversation = options.bindings?.[0]?.definition;
    const generation = conversation?.members.find((member) => member instanceof GenerateAnswer);
    configure(definition, { conversation, generation });
    return bind.call(this, definition, options);
  });
  try {
    return initialize();
  } finally {
    patched.mock.restore();
  }
}
