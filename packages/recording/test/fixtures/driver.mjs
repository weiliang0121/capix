import { Driver } from '@weiliang0121/capix-runtime';

export function installCallable(definition, options) {
  const { clock, observations, changes, ...binding } = options;
  const driver = new Driver({ clock, observations, changes });
  const bound = driver.build(definition, binding);
  return {
    id: driver.id,
    run: (input, options) => driver.run(bound, input, options),
  };
}
