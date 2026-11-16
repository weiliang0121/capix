// Explicit offline capacity probe, excluded from normal *.test.mjs discovery.
// Run after pnpm build, separately from tests and performance measurements:
// node --max-old-space-size=8192 packages/tool/test/benchmarks/capacity-large-request.mjs 16
// Repeat with 32 / 48, and append --checkpoint to exercise durable cold recovery.
// These are accumulated histories from a small origin, never 16/32/48 MiB initial inputs.
// CP mode stores small deterministic content descriptors as the original tool outputs;
// pure result mapping produces the large feedback. Raw 1.5 MiB outputs accumulate in the
// CP logical graph and can exceed its unchanged 8 MiB limit after only a few rounds.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import { ModelExchanges } from '@weiliang0121/capix-model-exchanges';
import { input } from '../fixture.mjs';
import { MiB, capacityHost, capacityAssembly, closeCapacityHost } from '../capacity-large-request-support.mjs';

const targetMiB = Number(process.argv[2]);
const checkpoint = process.argv.includes('--checkpoint');
if (![16, 32, 48].includes(targetMiB) || process.argv.slice(3).some((argument) => argument !== '--checkpoint')) throw new Error('Usage: capacity-large-request.mjs <16|32|48> [--checkpoint]');
const directory = mkdtempSync(join(tmpdir(), 'capix-capacity-'));
const stateDirectory = join(directory, 'interactions');
const checkpointDirectory = join(directory, 'checkpoints');
mkdirSync(stateDirectory);
mkdirSync(checkpointDirectory);
const states = {
  get(id) {
    return JSON.parse(readFileSync(join(stateDirectory, `${encodeURIComponent(id)}.json`), 'utf8'));
  },
  set(id, value) {
    writeFileSync(join(stateDirectory, `${encodeURIComponent(id)}.json`), JSON.stringify(value));
  },
};
const rounds = Math.ceil(targetMiB / 1.5);
const text = 'x'.repeat(Math.ceil((targetMiB * MiB) / rounds));
const options = { checkpoint, text, compactOutput: checkpoint, requestLimit: 64 * MiB, feedbackLimit: 2 * MiB - 1024 };
let memory = new MemoryCheckpointStore();
let count = 0;
let root;
const store = {
  read: (id) => memory.read(id),
  save(commit, revision) {
    const receipt = memory.save(commit, revision);
    root ??= receipt.contextId;
    writeFileSync(join(checkpointDirectory, `${count++}.json`), JSON.stringify({ commit, revision }));
    return receipt;
  },
  finish: (...args) => memory.finish(...args),
};
let host;
try {
  host = capacityHost({ states, rounds, requestLimit: 64 * MiB, retained: 1 });
  const effects = [];
  let fixture = capacityAssembly(host, { ...options, store: checkpoint ? store : undefined, effects });
  assert.equal(await fixture.runner.run(input), 'finished');
  assert.equal(effects.length, rounds);
  assert.ok(host.sent.at(-1).bytes > targetMiB * MiB);
  assert.ok(host.wire.at(-1).bytes > targetMiB * MiB);
  const report = { targetMiB, checkpoint, checkpointOutput: checkpoint ? 'small deterministic descriptor; 8 MiB CP graph limit unchanged' : null, rounds, requestBytes: host.sent.at(-1).bytes, wireBytes: host.wire.at(-1).bytes };
  writeFileSync(join(directory, 'exchanges.json'), JSON.stringify(fixture.entity.snapshot()));
  await closeCapacityHost(host);
  fixture = undefined;
  host = undefined;
  if (checkpoint) {
    // Reconstruct from JSON records and fresh registries; no live domain or interaction is reused.
    memory = new MemoryCheckpointStore();
    for (let index = 0; index < count; index++) {
      const { commit, revision } = JSON.parse(readFileSync(join(checkpointDirectory, `${index}.json`), 'utf8'));
      memory.save(commit, revision);
    }
    host = capacityHost({ states, rounds, requestLimit: 64 * MiB, forbidSend: true, retained: 1 });
    const after = [];
    const restored = capacityAssembly(host, { ...options, store: memory, entity: ModelExchanges.restore(JSON.parse(readFileSync(join(directory, 'exchanges.json'), 'utf8'))), effects: after });
    assert.equal(await restored.runner.resume(root), 'finished');
    assert.deepEqual(host.sent, []);
    assert.deepEqual(after, []);
    report.coldRecovery = 'completed without provider or tool effects';
  }
  console.log(JSON.stringify(report));
} finally {
  if (host) await closeCapacityHost(host);
  rmSync(directory, { recursive: true, force: true });
}
