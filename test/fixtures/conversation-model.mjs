/** Test-only text shorthand. Production always receives a complete ModelProvider reply. */
export function modelReply(text, overrides = {}) {
  return { id: 'test-reply', model: 'test-model', formatVersion: 1, output: [{ kind: 'text', text: text }], native: { format: 'chat-completions', version: 1 }, termination: { kind: 'completed', reason: 'stop' }, usage: null, ...overrides };
}

export function textProvider(model) {
  return {
    async complete(request, controls) {
      return modelReply(await model.generate(request.messages, controls));
    },
  };
}
