import { readFileSync } from 'node:fs';
import { restoreBundle } from './model.mjs';

try {
  const restored = restoreBundle(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  console.log(JSON.stringify({ validatedValues: restored.validatedValues, values: Object.fromEntries([...restored.records].map(([id, record]) => [id, record.value])) }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
