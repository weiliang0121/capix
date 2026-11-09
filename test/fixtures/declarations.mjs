import { Scene } from '@weiliang0121/capix-runtime';

/** A real Scene used by tests that focus on one selected child. */
export function runtimeDefinition(execution) {
  return new Scene({
    deps: {},
    async run(work) {
      const child = work.children.create(execution, work.input, { key: 'execution' });
      const output = await child.run();
      return child.accept(() => output);
    },
  }).add(execution);
}

export function recordedCall(recorder, invocation) {
  return [...recorder.book.values()].find((record) => record.contextId === invocation.context.id);
}
