import { DatabaseSync } from 'node:sqlite';
import { writeSync } from 'node:fs';
import { Node, Scene, checkpointPoint, childReference, reception } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { ConversationStore } from '@capix/conversation-service/persistence';

// Deliberate process-loss cuts use the real SQLite CheckpointStore. The separate
// ledger records actual body/effect/mapping executions; it never supplies recovery.
const [mode, path, fault = 'none'] = process.argv.slice(2);
const modes = new Set(['run', 'resume']);
const faults = new Set(['none', 'throw-before', 'throw-after', 'invalid-after', 'exit-effect', 'exit-before', 'exit-after', 'exit-before-root-failed', 'exit-root-failed', 'throw-root-after', 'mismatch-owner', 'mismatch-input', 'mismatch-contract']);
if (!modes.has(mode) || !faults.has(fault)) throw new Error('Invalid receipt fixture arguments');
const store = ConversationStore.open(path);
const ledger = new DatabaseSync(`${path}.ledger`);
ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL) STRICT;');
const codec = { encode: (value) => value, decode: (value) => value };
const leafKey = 'study.receipt.child';
const rootKey = 'study.receipt.root';
function event(kind, body = {}) {
  ledger.prepare('INSERT INTO events (kind,body) VALUES (?,?)').run(kind, JSON.stringify(body));
}
function report(extra = {}) {
  const root = store.checkpoints.listRoots().find((head) => head.image.contract.key === rootKey);
  const childId = root?.image.frame.children[0]?.identity.contextId;
  return {
    mode,
    fault,
    ...extra,
    root: root ? store.checkpoints.read(root.image.frame.owner.contextId) : null,
    child: childId ? (store.checkpoints.read(childId) ?? null) : null,
    events: ledger
      .prepare('SELECT seq,kind,body FROM events ORDER BY seq')
      .all()
      .map((row) => ({ seq: row.seq, kind: row.kind, ...JSON.parse(row.body) })),
  };
}
function print(value) {
  writeSync(1, `${JSON.stringify(value)}\n`);
}
function exitAt(cut) {
  print(report({ halted: cut }));
  process.exit(73); // No further catch/finally or Invocation cleanup after this cut.
}
const completed = checkpointPoint()({
  name: 'completed',
  state: codec,
  references: {},
  resume: {
    run(_work, state) {
      event('child-resume');
      return state;
    },
  },
});
const child = new Node({
  checkpoint: { key: leafKey, version: 1, input: codec, output: codec, points: [completed] },
  run(work) {
    event('child-body');
    const output = { text: `effect:${work.input.query}` };
    event('effect', { output });
    if (fault === 'exit-effect') exitAt('effect-before-child-checkpoint');
    work.checkpoint({ point: completed, state: output, refs: {} });
    return output;
  },
});
const received = reception(child, { ...codec, check: () => undefined });
const result = {
  succeeded(value) {
    event('accepted-mapping');
    return { answer: value.text };
  },
  failed(error) {
    event('handled-mapping', { message: error.message });
    return { answer: 'fallback must never authorize a receipt failure' };
  },
};
async function accept(work, handle) {
  try {
    const value = await handle.invoke({ result, reception: received });
    work.checkpoint({ point: accepted, state: value, refs: { child: handle.ref } });
    return value;
  } finally {
    const fact = work.children.facts.list(child)[0];
    event('parent-relation', { returned: fact.returned?.status, reception: fact.reception.status });
  }
}
const waiting = checkpointPoint()({
  name: 'waiting',
  state: codec,
  references: { child: childReference(child) },
  resume: {
    uses: [child],
    run(work, _state, refs) {
      event('parent-resume');
      return accept(work, work.children.resume(refs.child));
    },
  },
});
const accepted = checkpointPoint()({ name: 'accepted', state: codec, references: { child: childReference(child) }, resume: { run: (_work, state) => state } });
const scene = new Scene({
  checkpoint: { key: rootKey, version: 1, input: codec, output: codec, points: [waiting, accepted], receptions: [received] },
  run(work) {
    event('parent-body');
    const handle = work.children.create(child, work.input);
    work.checkpoint({ point: waiting, state: null, refs: { child: handle.ref } });
    return accept(work, handle);
  },
}).add(child);
const checkpoints = {
  read(id) {
    const head = store.checkpoints.read(id);
    if (!head || head.image.contract.key !== leafKey || !fault.startsWith('mismatch-')) return head;
    // A read-boundary adversarial variant, never a database rewrite. Parent-owned
    // identity/input/contract must reject even an otherwise valid successful head.
    const changed = structuredClone(head);
    if (fault === 'mismatch-owner') changed.image.frame.owner.parentContextId = 'different-parent';
    if (fault === 'mismatch-input') changed.image.frame.input = { query: 'different-input' };
    if (fault === 'mismatch-contract') changed.image.contract.version++;
    event('changed-read', { fault });
    return changed;
  },
  save(image, revision) {
    const receipt = store.checkpoints.save(image, revision);
    event('save', { contextId: image.frame.owner.contextId, contract: image.contract.key, point: image.point });
    return receipt;
  },
  finish(id, revision, delivery) {
    const contract = store.checkpoints.read(id).image.contract.key;
    event('finish-attempt', { contextId: id, contract, status: delivery.status });
    if (contract === leafKey && fault === 'exit-before') exitAt('child-before-finish-commit');
    if (contract === leafKey && fault === 'throw-before') throw new Error('child finish acknowledgement unavailable before commit');
    if (contract === rootKey && fault === 'exit-before-root-failed' && delivery.status === 'failed') exitAt('root-before-failed-commit');
    const receipt = store.checkpoints.finish(id, revision, delivery);
    event('finish-committed', { contextId: id, contract, status: delivery.status });
    if (contract === leafKey && fault === 'exit-after') exitAt('child-after-finish-commit');
    if (contract === leafKey && ['throw-after', 'exit-before-root-failed', 'exit-root-failed'].includes(fault)) throw new Error('child finish acknowledgement unavailable after commit');
    if (contract === leafKey && fault === 'invalid-after') return { ...receipt, revision: receipt.revision + 1 };
    if (contract === rootKey && fault === 'exit-root-failed' && delivery.status === 'failed') exitAt('root-after-failed-commit');
    if (contract === rootKey && fault === 'throw-root-after') throw new Error('root finish acknowledgement unavailable after commit');
    return receipt;
  },
};
const runner = new Runner(scene, new Resources(), undefined, {
  checkpoints: { store: checkpoints },
  observations: [
    {
      bindInvocation: () => ({
        observe(fact) {
          if (fact.kind === 'relation' && fact.change.kind === 'returned' && fact.change.result.status === 'failed') event('failed-return', { contextId: fact.identity.contextId, receptionAllowed: fact.change.result.failure?.receptionAllowed });
          if (fact.kind === 'finished' && fact.identity.parentContextId === undefined) event('root-work-finished', { contextId: fact.identity.contextId, status: fact.state.status });
        },
      }),
    },
  ],
}).build();
runner.observation.subscribe({
  receive(value) {
    if (value.source === 'checkpoint' && value.fact.kind === 'child-restored') event('child-restored', { mode: value.fact.mode, contextId: value.fact.child.identity.contextId });
  },
});
try {
  const root = store.checkpoints.listRoots().find((head) => head.image.contract.key === rootKey);
  const value = mode === 'resume' ? await runner.resume(root.image.frame.owner.contextId) : await runner.run({ query: 'one' });
  print(report({ result: value }));
} catch (error) {
  print(report({ error: { name: error.name, code: error.code, message: error.message } }));
  process.exitCode = 1;
} finally {
  store.close();
  ledger.close();
}
