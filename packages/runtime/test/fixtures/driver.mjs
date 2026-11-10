import { Driver } from '@weiliang0121/capix-runtime';

/** Test harness for one built callable and its owning Driver. */
export function installCallable(definition, options) {
  const { clock, observations, checkpoints, changes, ...binding } = options;
  const driver = new Driver({ clock, observations, checkpoints, changes });
  const bound = driver.build(definition, binding);
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
