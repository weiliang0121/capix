import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { FactStore } from './fact-store.mjs';
import { FactCall } from './fact-call.mjs';
import { checkCaptured, checkMaintenance, checkTools, restorePoint, seedCapture, seedMaintenance, seedTools } from './author-scenarios.mjs';

// Artificial external effect counter; never consulted for recovery decisions.
const [mode, path, scenario, cut = 'none'] = process.argv.slice(2);
const store = new FactStore(path);
const ledger = new DatabaseSync(`${path}.ledger`);
ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS effects(kind TEXT NOT NULL) STRICT;');
const event = (kind) => ledger.prepare('INSERT INTO effects VALUES (?)').run(kind);
const stop = () => process.exit(73);
const fault = (stage) => (at) => {
  if (`${stage}-${at}` === cut) stop();
};
const output = (result) => writeSync(1, JSON.stringify({ ...result, effects: ledger.prepare('SELECT kind,count(*) n FROM effects GROUP BY kind').all() }) + '\n');

function acceptTool(call, state) {
  const active = call.referenceOf('active');
  const value = call.value(call.relation(active).output);
  event('mapping');
  call.receive(active, { exchange: 'exchange-1', slot: 3, status: 'ok', text: value.text });
  call.clearReference('active');
  call.save('processing', { ...state, cursor: 4, phase: 'processing' }, { check: checkTools, fault: fault('accept') });
}

try {
  if (mode === 'run') {
    if (scenario === 'tools') {
      const { call, active, state } = seedTools(store);
      if (cut === 'waiting-no-child') stop();
      const child = new FactCall(store, active, { exchange: 'exchange-1', slot: 3 });
      event('effect');
      child.save('captured', { text: 'external result' });
      if (cut === 'child-active') stop();
      child.finish({ text: 'external result' });
      if (cut === 'child-finished') stop();
      call.resolve(active);
      acceptTool(call, state);
      call.finish({ text: 'answer' });
    } else if (scenario === 'maintenance') {
      seedMaintenance(store);
      stop();
    } else if (scenario === 'capture') {
      event('source-read');
      seedCapture(store);
      stop();
    } else throw new Error('Unknown scenario');
    output({ status: 'completed' });
  } else if (mode === 'resume') {
    const owner = scenario === 'tools' ? 'tools' : scenario === 'maintenance' ? 'maintenance' : 'capture';
    const head = store.readHead(owner);
    if (head?.status !== 'active') output({ status: 'terminal' });
    else if (scenario === 'tools') {
      const { call, state } = restorePoint(store, owner, 'author-tools@1', { waiting: checkTools, processing: checkTools });
      const active = call.referenceOf('active');
      if (active) {
        const resolved = call.resolve(active);
        if (resolved.mode === 'continuation') {
          // Use the saved local material; never repeat the artificial effect.
          FactCall.reopen(store, active.contextId).finish(resolved.state);
          call.resolve(active);
        }
        acceptTool(call, state);
      }
      assert.equal(call.relationCount('tool', 'author-tool@1'), 3);
      assert.equal(call.relation(call.references('tools')[1]).phase, 'handled');
      call.finish({ text: 'answer' });
      output({ status: 'completed', refs: call.referenceSize('tools') });
    } else if (scenario === 'maintenance') {
      const { call } = restorePoint(store, owner, 'author-maintenance@1', { completed: checkMaintenance });
      assert.equal(call.referenceOf('proposal'), undefined);
      call.finish(undefined);
      output({ status: 'completed' });
    } else {
      const { call, state } = restorePoint(store, owner, 'author-capture@1', { captured: checkCaptured });
      const material = call.value(state.material);
      call.finish(material);
      output({ status: 'completed', text: material.text, version: material.version });
    }
  } else throw new Error('Unknown mode');
} catch (error) {
  output({ status: 'rejected', error: error.message });
} finally {
  ledger.close();
  store.close();
}
