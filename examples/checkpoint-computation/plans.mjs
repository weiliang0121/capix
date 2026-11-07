const stores = ['memory', 'sqlite'];

export function benchmarkPlans(suite) {
  const plans = [];
  const add = (plan) => plans.push({ valueBytes: 64, check: 'local', pattern: 'seeded', diagnosticSaves: 16, ...plan });
  if (suite === 'migration') {
    for (const store of stores) for (const refs of ['current', 'all']) for (const n of [128, 512, 2048]) add({ id: ['migration-growth', store, refs, n].join('-'), family: 'growth', store, refs, n, inputBytes: 1024 });
    for (const store of stores) for (const inputBytes of [500 * 1024, 2 * 1024 * 1024]) add({ id: ['migration-input', store, inputBytes].join('-'), family: 'input', store, refs: 'current', n: 128, inputBytes });
    for (const store of stores) add({ id: 'migration-value-' + store, family: 'growth', store, refs: 'current', n: 128, inputBytes: 1024, valueBytes: 16 * 1024 });
  }
  if (suite === 'first' || suite === 'extended' || suite === 'all') {
    const sizes = suite === 'first' ? [32, 128, 512] : suite === 'extended' ? [1000, 2048] : [32, 128, 512, 1000, 2048];
    for (const store of stores) for (const refs of ['current', 'all']) for (const n of sizes) add({ id: ['growth', store, refs, n].join('-'), family: 'growth', store, refs, n, inputBytes: 1024 });
  }
  if (suite === 'first' || suite === 'all') {
    for (const store of stores) for (const n of [0, 128]) for (const inputBytes of [0, 1024, 50 * 1024, 500 * 1024, 2 * 1024 * 1024]) add({ id: ['input', store, n, inputBytes].join('-'), family: 'input', store, refs: 'current', n, inputBytes });
  }
  if (suite === 'supplement' || suite === 'all') {
    for (const valueBytes of [1024, 16 * 1024]) add({ id: 'value-sqlite-' + valueBytes, family: 'growth', store: 'sqlite', refs: 'current', n: 128, inputBytes: 1024, valueBytes });
    for (const n of [128, 512]) add({ id: 'check-sqlite-' + n, family: 'growth', store: 'sqlite', refs: 'current', n, inputBytes: 1024, check: 'full' });
    for (const store of stores) add({ id: 'repeat-' + store, family: 'input', store, refs: 'current', n: 128, inputBytes: 500 * 1024, pattern: 'repeat' });
  }
  if (suite === 'overhead') for (const store of stores) for (const refs of ['current', 'all']) add({ id: ['overhead', store, refs].join('-'), family: 'growth', store, refs, n: 128, inputBytes: 1024 });
  if (!plans.length) throw new Error('Unknown suite: ' + suite);
  return plans;
}

export function quantile(values, probability) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * probability;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}
