import assert from 'node:assert/strict';
import { Journal, World } from './model.mjs';
import { execute } from './scenario.mjs';

const action = process.argv[2];
const directory = process.argv[3];
const mode = process.argv[4];
const options = JSON.parse(process.argv[5] ?? '{}');
assert.ok(['explicit', 'replay'].includes(mode), 'Expected explicit or replay');
const journal = new Journal(directory);
const world = new World(directory);
let output = {};
try {
  if (action === 'mutate') {
    journal.mutate(options);
    world.mutate(options);
    output = { status: 'mutated' };
  } else if (action === 'terminal') {
    journal.terminal(options.status);
    output = { status: 'terminated' };
  } else if (action === 'inspect') output = { status: 'inspected' };
  else {
    assert.ok(['run', 'resume'].includes(action));
    if (options.source !== undefined) world.source = options.source;
    output = execute(journal, world, mode, options, action === 'resume');
  }
} catch (error) {
  output = { status: 'rejected', error: error?.message ?? String(error) };
} finally {
  // Only observation belongs here. Hard cuts bypass this block; no workflow
  // progress or external acknowledgment is fabricated in cleanup.
  try {
    output = { ...output, head: journal.head, commands: journal.commands(), metrics: journal.metrics, world: world.snapshot() };
  } catch (error) {
    output = { ...output, inspectionError: error.message, metrics: journal.metrics, world: world.snapshot() };
  }
  console.log(JSON.stringify(output));
  world.close();
  journal.close();
}
