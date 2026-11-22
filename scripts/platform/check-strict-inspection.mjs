import { readFile } from 'node:fs/promises';
import { types } from 'node:util';
import { runInThisContext } from 'node:vm';

const source = await readFile(new URL('./strict-inspection.js', import.meta.url), 'utf8');
const { descriptorClassifier, run } = runInThisContext(source, { filename: 'strict-inspection.js' });
const result = run(descriptorClassifier(types.isProxy));

console.log(JSON.stringify({ host: process.platform, engine: `Node ${process.version}`, mode: 'node:util.types.isProxy', ...result }, null, 2));
if (result.failures.length > 0) process.exitCode = 1;
