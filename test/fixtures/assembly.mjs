import { mock } from 'node:test';
import { CallableBuilder } from '@weiliang0121/capix-runtime';
import { ConversationGroup, GenerateAnswer } from '@capix/observer-service/conversation';

/** Assign only the requested fields while the host-created structure is still configurable. */
export function reconfigure(callable, changes) {
  Object.assign(callable, changes);
  return callable;
}

/** Configure a host-created declaration before its synchronous binding, without adding a production hook. */
export function withRuntimeDefinition(configure, initialize) {
  if (!configure) return initialize();
  const build = CallableBuilder.prototype.build;
  const patched = mock.method(CallableBuilder.prototype, 'build', function (definition, resources, interactions, options) {
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
