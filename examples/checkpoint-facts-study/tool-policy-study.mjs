import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createToolPolicyFixture } from './tool-policy-fixture.mjs';
import { ToolPolicyProbe } from './tool-policy.mjs';

const difference = (after, before) => Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - (before[key] ?? 0)]));

export function studyToolPolicy() {
  const fixture = createToolPolicyFixture();
  const probe = new ToolPolicyProbe(fixture);
  const rows = [];
  for (const snapshot of fixture.snapshots.values()) {
    const counts = { modelRequires: 0, allRelationItems: 0 };
    const facts = fixture.facts(snapshot);
    const require = facts.children.require;
    const values = facts.children.values;
    facts.children.require = (definition, reference) => {
      if (definition === fixture.definitions.model) counts.modelRequires++;
      return require(definition, reference);
    };
    facts.children.values = () => {
      const entries = values();
      counts.allRelationItems += entries.length;
      return entries;
    };
    fixture.points.get(snapshot.point).check(snapshot.state, facts);
    const before = { ...probe.stats };
    probe.feed(snapshot);
    probe.acknowledge(probe.prepare());
    rows.push({ name: snapshot.name, original: counts, candidate: difference(probe.stats, before), models: snapshot.refs.models.length, relations: snapshot.records.length });
  }
  const before = { ...probe.stats };
  probe.acknowledge(probe.prepare());
  const repeated = difference(probe.stats, before);
  assert.equal(repeated.modelAssertions, 0);
  assert.equal(repeated.currentQueries, 1);
  return {
    scope: 'Isolated actual ToolLoop policy comparison; not total save or production performance',
    rows,
    original: rows.reduce((total, row) => ({ modelRequires: total.modelRequires + row.original.modelRequires, allRelationItems: total.allRelationItems + row.original.allRelationItems }), { modelRequires: 0, allRelationItems: 0 }),
    candidate: { ...probe.stats },
    repeated,
    index: probe.indexStats,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  assert.ok(directory, 'Provide a new output directory');
  mkdirSync(directory, { recursive: false });
  const files = ['tool-policy.mjs', 'tool-policy-fixture.mjs', 'tool-relations.mjs', 'tool-prefix.mjs', 'tool-confirm.mjs'];
  const sources = Object.fromEntries(
    files.map((name) => [
      name,
      createHash('sha256')
        .update(readFileSync(new URL(name, import.meta.url)))
        .digest('hex'),
    ]),
  );
  const production = ['services/conversation/src/tools/loop.ts', 'server/model-exchanges/src/exchanges.ts'];
  for (const name of production) sources[name] = createHash('sha256').update(readFileSync(name)).digest('hex');
  const summary = { ...studyToolPolicy(), sources };
  writeFileSync(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ output: join(directory, 'summary.json'), original: summary.original, candidate: summary.candidate, repeated: summary.repeated }));
}
