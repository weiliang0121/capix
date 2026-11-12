import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const entries = ['dictionary', 'entities', 'invocation-exit', 'notes-assistant', 'presets', 'records', 'runner-output', 'runner', 'tool', 'view-membership', 'view'];
const files = (await readdir(new URL('../../examples/', import.meta.url))).filter((name) => name.endsWith('.mjs')).sort();
assert.deepEqual(files, entries.map((name) => `${name}.mjs`).sort(), 'Every public example entry must have a real execution check');
for (const entry of entries) {
  const args = ['dictionary', 'presets'].includes(entry) ? ['scripts/examples/factories.mjs', entry] : [`examples/${entry}.mjs`];
  const commands = entry === 'notes-assistant' ? [args, ['examples/notes/verify.mjs']] : [args];
  for (const command of commands) {
    const child = spawnSync(process.execPath, command, { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, NODE_OPTIONS: '' } });
    if (child.error || child.status !== 0) {
      process.stderr.write(child.stdout ?? '');
      process.stderr.write(child.stderr ?? '');
      throw new Error(`Example ${entry} failed at ${command[0]} (${child.error?.message ?? child.signal ?? child.status})`);
    }
  }
  console.log(`PASS ${entry}`);
}
console.log(`${entries.length} offline example entries executed with assertions`);
