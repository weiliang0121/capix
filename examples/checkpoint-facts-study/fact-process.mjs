import { writeSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { FactStore, identity } from './fact-store.mjs';
import { FactCall } from './fact-call.mjs';

// Deliberate hard exits bypass all cleanup. The ledger measures side effects;
// it is never consulted to decide whether recovery may continue.
const [mode, path, cut = 'none'] = process.argv.slice(2);
const store = new FactStore(path);
const ledger = new DatabaseSync(`${path}.ledger`);
ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS effects(kind TEXT NOT NULL) STRICT;');
const event = (kind) => ledger.prepare('INSERT INTO effects VALUES (?)').run(kind);
function output(value) {
  writeSync(1, JSON.stringify({ ...value, effects: ledger.prepare('SELECT kind,count(*) n FROM effects GROUP BY kind').all(), root: store.readHead('parent')?.status ?? null }) + '\n');
}
function stop() {
  process.exit(73);
}
function fault(boundary) {
  return (at) => {
    if (`${boundary}-${at}` === cut) stop();
  };
}
function accept(root, child) {
  const value = root.value(root.relation(child).output);
  event('mapping');
  root.receive(child, { answer: value.text });
  root.save('accepted', null, { fault: fault('parent-accept') });
}
try {
  if (mode === 'run') {
    const root = new FactCall(store, identity('parent'), { query: 'once' });
    root.save('prepared', null);
    const child = root.createChild('child', { query: 'once' });
    root.reference('active', child);
    root.save('waiting', null, { fault: fault('parent-waiting') });
    const childCall = new FactCall(store, child, { query: 'once' });
    event('effect');
    if (cut === 'effect-no-child') stop();
    childCall.save('completed-body', { text: 'result' });
    try {
      childCall.finish(
        { text: 'result' },
        {
          fault: (at) => {
            fault('child-finish')(at);
            if (at === 'committed' && cut.startsWith('parent-failed-')) throw new Error('lost child receipt');
          },
        },
      );
    } catch (error) {
      if (!cut.startsWith('parent-failed-')) throw error;
      root.fail({ fault: fault('parent-failed') });
      throw error;
    }
    root.resolve(child);
    accept(root, child);
    root.finish({ answer: 'result' }, { fault: fault('root-finish') });
    output({ status: 'completed' });
  } else if (mode === 'resume') {
    const root = FactCall.reopen(store, 'parent');
    if (store.readHead('parent').status !== 'active') {
      output({ status: 'terminal' });
    } else {
      const relation = root.allRelations()[0];
      if (!relation) output({ status: 'not-dispatched' });
      else {
        const child = relation.identity;
        if (relation.phase === 'waiting') {
          const resolved = root.resolve(child);
          if (resolved.mode === 'continuation') {
            event('continuation');
            FactCall.reopen(store, child.contextId).finish(resolved.state);
            root.resolve(child);
          }
        }
        if (root.relation(child).phase !== 'accepted') accept(root, child);
        root.finish({ answer: 'result' });
        output({ status: 'completed' });
      }
    }
  } else throw new Error('Unknown fixture mode');
} catch (error) {
  output({ status: 'rejected', error: error.message });
} finally {
  ledger.close();
  store.close();
}
