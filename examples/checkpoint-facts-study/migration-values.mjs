// Shared only by this experiment's module-loading probe. No public package API.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { StableValues } from './stable.mjs';

const values = new StableValues();
const boundaries = {};
const modules = new Set();
const rejected = [];
const refusalCodes = new Map([['Unsupported delivery prototype', 'UNSUPPORTED_PROTOTYPE'], ['Unsupported delivery value', 'UNSUPPORTED_VALUE'], ['Cyclic delivery value', 'CYCLIC_VALUE'], ['Accessors/non-enumerable values are unsupported', 'UNSUPPORTED_PROPERTY'], ['Symbol properties are unsupported', 'UNSUPPORTED_PROPERTY'], ['Sparse/extended arrays are unsupported', 'UNSUPPORTED_ARRAY'], ...['depth', 'objects', 'entries', 'textUnits'].map((name) => [`Stable ${name} budget exceeded`, `BUDGET_${name.toUpperCase()}`])]);

function refusalCode(cause) {
  // Inspect only an own data descriptor, and never allow inspection itself to
  // change failure eligibility. Unknown text is NOT copied to census artifacts.
  try {
    if (cause === null || !['object', 'function'].includes(typeof cause)) return 'FIXATION_FAILED';
    const descriptor = Object.getOwnPropertyDescriptor(cause, 'message');
    return descriptor && Object.hasOwn(descriptor, 'value') ? (refusalCodes.get(descriptor.value) ?? 'FIXATION_FAILED') : 'FIXATION_FAILED';
  } catch {
    return 'FIXATION_FAILED';
  }
}

export class StableBoundaryFailure extends TypeError {
  constructor(boundary, cause, reason) {
    super(`Stable delivery rejected at ${boundary}: ${reason}`, { cause });
    this.boundary = boundary;
  }
}

export function fixed(value, boundary) {
  boundaries[boundary] = (boundaries[boundary] ?? 0) + 1;
  try {
    return values.own(value);
  } catch (cause) {
    const reason = refusalCode(cause);
    if (rejected.length < 100) rejected.push({ boundary, reason });
    throw new StableBoundaryFailure(boundary, cause, reason);
  }
}

export function protectedFailure(value) {
  return value instanceof StableBoundaryFailure;
}

export function fixedReception(saved) {
  // The relation wrapper is mechanism metadata. Only its data output is a delivery value.
  return saved && Object.hasOwn(saved, 'output') ? Object.freeze({ ...saved, output: fixed(saved.output, 'decode:raw-reception') }) : saved;
}

export function loaded(path) {
  modules.add(path);
}

export function statistics() {
  return { boundaries: { ...boundaries }, modules: [...modules], rejected: [...rejected], visits: values.visits, reused: values.reused, encodes: values.encodes };
}

// The directory is created by census.mjs. Data contains labels/counts only, no IO values.
if (process.env.CAPIX_STABLE_STUDY_DIR) {
  process.once('exit', () => {
    writeFileSync(join(process.env.CAPIX_STABLE_STUDY_DIR, `process-${process.pid}.json`), JSON.stringify(statistics()));
  });
}
