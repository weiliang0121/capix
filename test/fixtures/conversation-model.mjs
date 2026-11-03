/** Test-only text shorthand. Production always receives a complete ModelProvider reply. */
export function modelReply(text, overrides = {}) {
  return { id: 'test-reply', model: 'test-model', text, finishReason: 'stop', usage: null, ...overrides };
}

export function textProvider(model) {
  return {
    async complete(request, controls) {
      return modelReply(await model.generate(request.messages, controls));
    },
  };
}
