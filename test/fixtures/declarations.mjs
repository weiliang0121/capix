import { invocationRecording } from '@capix/server-runtime';

/** A real R declaration used by tests that focus on one selected E. */
export function runtimeDefinition(execution) {
  return {
    level: 'runtime',
    maxRounds: 1,
    raises: execution.raises ?? [],
    children: [execution],
    run: {
      requires: {},
      uses: [execution],
      async execute(work) {
        const child = work.children.create(execution, work.input, { key: 'execution' });
        const output = await child.run();
        return child.accept(() => output);
      },
    },
  };
}

/** Recording is an explicit declaration throughout the tested subtree. */
export function recordDefinitions(definition) {
  definition.observation ??= [invocationRecording({}, { failure: 'propagate' })];
  for (const child of definition.children ?? []) recordDefinitions(child);
  return definition;
}

export function recordedCall(recorder, invocation) {
  return [...recorder.book.values()].find((record) => record.contextId === invocation.context.id);
}
