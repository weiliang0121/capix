// Executed in a fresh installation whose only requested package is Runtime.
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { Node, Scene, Runner, Resources } from '@weiliang0121/capix-runtime';

const installed = await readdir(new URL('./node_modules/@weiliang0121/', import.meta.url));
assert.deepEqual(
  installed.sort(),
  ['changes', 'checkpoint', 'contracts', 'diagnostics', 'invocation', 'platform', 'platform-node', 'resources', 'runtime', 'structure'].map((name) => `capix-${name}`),
);
const answer = new Node({ run: (work) => work.input + 1 });
const runner = new Runner(new Scene(answer), new Resources()).build();
assert.equal(await runner.run(41), 42);
console.log('Verified the standalone Runtime installation and Scene execution');
