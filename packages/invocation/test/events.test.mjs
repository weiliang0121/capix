import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import * as events from '@weiliang0121/capix-invocation/events';
import * as invocation from '@weiliang0121/capix-invocation';

test('pure events entrypoint shares its vocabulary with the root and loads no live implementation', async () => {
  assert.deepEqual(events.invocationProcessStages, ['execute', 'receive', 'handling', 'control']);
  assert.deepEqual(events.invocationProcessActions, ['start', 'return', 'throw', 'continue', 'unhandled', 'stop']);
  assert.equal(events.invocationProcessStages, invocation.invocationProcessStages);
  assert.equal(events.invocationProcessActions, invocation.invocationProcessActions);
  assert.deepEqual(Object.keys(events).sort(), ['invocationProcessActions', 'invocationProcessStages']);
  const compiled = await readFile(new URL('../dist/events.js', import.meta.url), 'utf8');
  assert.doesNotMatch(compiled, /\b(?:import|export)\s.*?\bfrom\b|\bimport\s*\(|node:|require\s*\(/);
  const declaration = await readFile(new URL('../dist/events.d.ts', import.meta.url), 'utf8');
  for (const match of declaration.matchAll(/from\s+['"]([^'"]+)['"]/g)) assert.equal(match[1], '@weiliang0121/capix-contracts');
});
