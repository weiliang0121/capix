import { ConversationStore } from '@capix/conversation-service/persistence';

// Test-only crash injection after real SQLite commits. SIGKILL cannot finalize
// the invocation or rewrite its saved CP as a normal thrown-error delivery.
const open = ConversationStore.open;
const target = process.env.CAPIX_TEST_CRASH;
ConversationStore.open = function (path) {
  const store = open.call(this, path);
  const crash = () => process.kill(process.pid, 'SIGKILL');
  const interactions = store.interactions;
  store.interactions = {
    create(state) {
      const result = interactions.create(state);
      if (target === 'prepared-request') crash();
      return result;
    },
    commit(change) {
      const result = interactions.commit(change);
      if (target === 'answer-feedback' && change.state.feedback && change.state.request.responseFormat !== 'json_object') crash();
      return result;
    },
    read: (id) => interactions.read(id),
  };
  const transcript = store.transcript;
  store.transcript = {
    commit(change) {
      const result = transcript.commit(change);
      if (target === 'answer-append' && change.kind === 'append' && change.messages.some((message) => message.role === 'assistant')) crash();
      return result;
    },
  };
  const memories = store.memories;
  store.memories = {
    commit(change) {
      const result = memories.commit(change);
      if (target === 'memory-apply' && change.fixed) crash();
      return result;
    },
  };
  return store;
};
