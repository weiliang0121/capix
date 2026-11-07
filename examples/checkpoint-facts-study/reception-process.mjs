import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';

// Fresh-process check of the isolated fact protocol, not a production resume
// adapter. No resource effect, ordinary JS stack or mutable draft is replayed.
const [mode, path, cut = 'committed', scenario = 'accepted'] = process.argv.slice(2);
const store = new FactStore(path);
const owner = identity('parent');
const child = identity('child', 'parent', 'child', 1);
let threshold = mode === 'resume' && scenario === 'impure' ? 80 : 60;
let mappings = 0;
let call;
const contract = {
  key: 'study.reception.cold',
  version: mode === 'resume' && scenario === 'changed-contract' ? 2 : 1,
  childPosition: 'child',
  check(value) {
    assert.ok(Number.isSafeInteger(value.step) && value.step > 0);
    assert.equal(typeof value.text, 'string');
    assert.equal(typeof value.score, 'number');
    // Deliberate negative control: closure state is NOT a supported dependency.
    if (scenario === 'impure') assert.ok(value.score >= threshold, 'Mutable threshold changed');
  },
  codec: {
    encode: (value) => value,
    decode(value) {
      if (mode === 'resume' && scenario === 'invalid-decoder') return { ...value, text: 42 };
      return value;
    },
  },
};

function report(status, error) {
  writeSync(1, `${JSON.stringify({ status, error: error?.message, mappings, evidence: call ? { ...call.stats } : null, store: { ...store.stats }, head: store.readHead('parent')?.point ?? null, value: call && ['accepted', 'handled'].includes(call.relation(child).phase) ? call.value(child) : null })}\n`);
}

function stop() {
  report('cut');
  process.exit(73); // Intentionally bypasses all finally blocks.
}

function establish(kind = 'accepted') {
  mappings++;
  const draft = { step: 1, text: 'accepted material', score: 70 };
  call.establish(child, kind, draft, contract);
  draft.text = 'producer alias changed';
}

try {
  if (mode === 'run') {
    call = new ReceptionEvidenceCall(store, owner, { query: 'fixed input' }, { contracts: [contract] });
    assert.deepEqual(call.createChild('child', { step: 1 }), child);
    if (scenario === 'handled') {
      call.save('waiting', null);
      call.failed(child, { message: 'business exception' });
      establish('handled');
    } else {
      call.returned(child, { text: 'child result' });
      call.beginReception(child, contract);
      call.save('receiving', null);
      establish();
    }
    if (cut === 'before-save') stop();
    call.save(
      'accepted',
      { cursor: 1 },
      {
        fault: (boundary) => {
          if (boundary === cut && scenario !== 'impure') stop();
        },
      },
    );
    if (scenario === 'impure') {
      threshold = 80;
      const previous = call.stats.persistenceCheck;
      call.save('later-point', { cursor: 2 });
      assert.equal(call.stats.persistenceCheck, previous, 'Hot save does not track mutable policy');
      stop();
    }
    report('completed');
  } else if (mode === 'resume') {
    call = ReceptionEvidenceCall.reopen(store, owner, { contracts: [contract] });
    const relation = call.relation(child);
    if (relation.phase === 'receiving') establish();
    else assert.ok(['accepted', 'handled'].includes(relation.phase), 'No recoverable reception');
    call.save('verified', { cursor: 1 });
    report('completed');
  } else throw new Error('Unknown fixture mode');
} catch (error) {
  report('rejected', error);
} finally {
  store.close();
}
