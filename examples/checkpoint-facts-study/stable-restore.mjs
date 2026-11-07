import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { StableValues } from './stable.mjs';

// Only restores the candidate VALUE domain, not an Invocation or its CP.
try {
  const bodies = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  assert.ok(Array.isArray(bodies));
  const stable = new StableValues();
  const values = bodies.map((body) => stable.decode(body));
  let protectedObjects = 0;
  const inspect = (value) => {
    if (value && typeof value === 'object') {
      assert.equal(Reflect.set(value, '__probe__', true), false);
      protectedObjects++;
      for (const child of Object.values(value)) inspect(child);
    }
  };
  for (const value of values) inspect(value);
  console.log(JSON.stringify({ bodies: values.map((value) => stable.encode(value)), protectedObjects, visits: stable.visits }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
