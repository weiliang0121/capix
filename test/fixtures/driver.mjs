import { Driver } from '@capix/server-runtime';

/** Test harness for one installed callable; production callers hold Driver and Bound separately. */
export function installCallable(definition, options) {
  const { clock, observations, checkpoints, changes, ...binding } = options;
  const driver = new Driver({ clock, observations, checkpoints, changes });
  const bound = driver.bind(definition, binding);
  return {
    driver,
    bound,
    get id() {
      return driver.id;
    },
    get running() {
      return driver.isRunning(bound);
    },
    run(input, runOptions) {
      return driver.run(bound, input, runOptions);
    },
    resume(contextId, runOptions) {
      return driver.resume(bound, contextId, runOptions);
    },
  };
}
