import assert from 'node:assert/strict';
import { FactStore, identity } from './fact-store.mjs';
import { ReceptionEvidenceCall } from './reception-evidence.mjs';

const difference = (after, before) => Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - (before[key] ?? 0)]));

// Deterministic candidate-model counts only. The comparison's production
// baseline is measured separately through the REAL Invocation/Frame-v5 path.
export function measureReceptionCost({ children }) {
  const store = new FactStore();
  let saving = false;
  let current = 0;
  let saveChecks = 0;
  let oldSaveChecks = 0;
  let saveEncodes = 0;
  let oldSaveEncodes = 0;
  const contract = {
    key: 'study.reception.value',
    version: 1,
    childPosition: 'child',
    check(value) {
      if (saving) {
        saveChecks++;
        if (value.step < current) oldSaveChecks++;
      }
      assert.ok(Number.isSafeInteger(value.step) && value.step > 0);
      assert.equal(typeof value.text, 'string');
    },
    codec: {
      encode(value) {
        if (saving) {
          saveEncodes++;
          if (value.step < current) oldSaveEncodes++;
        }
        return value;
      },
      decode: (value) => value,
    },
  };
  const call = new ReceptionEvidenceCall(store, identity('parent'), { material: 'h'.repeat(1024) }, { contracts: [contract] });
  const samples = [];
  function save(point) {
    const before = { ...call.stats };
    const beforeStore = { ...store.stats };
    const beforeChecks = saveChecks;
    const beforeEncodes = saveEncodes;
    saving = true;
    try {
      call.save(point, { step: current, phase: point });
    } finally {
      saving = false;
    }
    samples.push({ step: current, point, evidence: difference(call.stats, before), store: difference(store.stats, beforeStore), receptionChecks: saveChecks - beforeChecks, receptionEncodes: saveEncodes - beforeEncodes });
  }
  try {
    for (current = 1; current <= children; current++) {
      const child = call.createChild(`child-${current}`, { step: current });
      save('waiting');
      call.returned(child, { step: current, text: 'constant result' });
      const draft = { step: current, text: 'constant result' };
      call.establish(child, 'accepted', draft, contract);
      draft.text = 'changed producer alias';
      assert.equal(call.value(child).text, 'constant result');
      save('accepted');
    }
    current = children;
    const before = { ...call.stats };
    const beforeStore = { ...store.stats };
    const measured = { config: { children }, saves: samples.length, counts: { ...call.stats }, store: { ...store.stats }, saveChecks, oldSaveChecks, saveEncodes, oldSaveEncodes };
    save('accepted');
    return { ...measured, unchangedSave: { evidence: difference(call.stats, before), store: difference(store.stats, beforeStore) }, samples };
  } finally {
    store.close();
  }
}
