import { mock } from 'node:test';
import { CallableBuilder } from '@capix/server-runtime';
import { ConversationGroup, GenerateAnswer } from '@capix/observer-service/conversation';

/** Test mutations use the same full replacement contract as author configuration. */
export function reconfigure(callable, changes) {
  const { name, label, source, callee, maxRounds, raises, output, deps, uses, run, accept, exceptions, observation, checkpoint, receptions } = callable;
  callable.setDefinition({ name, label, source, callee, maxRounds, raises, output, deps, uses, run, accept, exceptions, observation, checkpoint, receptions, ...changes });
  return callable;
}

/** Configure a host-created declaration before its synchronous binding, without adding a production hook. */
export function withRuntimeDefinition(configure, initialize) {
  if (!configure) return initialize();
  const build = CallableBuilder.prototype.buildResources;
  const patched = mock.method(CallableBuilder.prototype, 'buildResources', function (definition, resources, interactions, options) {
    const conversation = definition.members?.find((member) => member instanceof ConversationGroup);
    const generation = conversation?.members.find((member) => member instanceof GenerateAnswer);
    configure(definition, { conversation, generation });
    return build.call(this, definition, resources, interactions, options);
  });
  try {
    return initialize();
  } finally {
    patched.mock.restore();
  }
}
