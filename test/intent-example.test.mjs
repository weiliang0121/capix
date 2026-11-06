import { modelReply } from './fixtures/conversation-model.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCase, runMatrix } from '../examples/intent/experiment.mjs';
import { acceptDecision } from '../examples/intent/catalog.mjs';
import { fixtures } from '../examples/intent/fixtures.mjs';

const select = (node, evidence = []) => ({ kind: 'select', node, reason: '用于验证契约的固定响应', evidence, question: null });
const reply = (decision, extra = {}) => modelReply(JSON.stringify(decision), extra);
const fixture = (id) => fixtures.find((item) => item.id === id);

test('intent example invokes a real registered candidate through the public resource/structure/runner chain', async () => {
  const requests = [];
  const row = await runCase({
    fixture: fixture('explicit-translation'),
    condition: 'input',
    model: {
      complete: async (request) => {
        requests.push(request);
        return reply(select('translate'));
      },
    },
  });
  assert.equal(row.status, 'select');
  assert.equal(row.plan.node, 'translate');
  assert.equal(row.plan.mode, 'plan-only');
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0].messages[1].content);
  assert.deepEqual(Object.keys(payload).sort(), ['catalog', 'material', 'query']);
  assert.equal(payload.catalog.length, 8);
  assert.deepEqual(payload.material, []);
  assert.equal(Object.hasOwn(payload, 'expected'), false);
});

test('view ablation does not leak hidden message evidence through memory sources', async () => {
  const snapshots = new Map();
  for (const condition of ['input', 'history', 'memory', 'full']) {
    const row = await runCase({
      fixture: fixture('memory-convention'),
      condition,
      model: {
        complete: async (request) => {
          snapshots.set(condition, JSON.parse(request.messages[1].content).material);
          return reply({ kind: 'clarify', node: null, reason: '固定响应', evidence: [], question: '需要怎样处理？' });
        },
      },
    });
    assert.equal(row.status, 'clarify');
  }
  assert.deepEqual(snapshots.get('input'), []);
  assert.equal(snapshots.get('history').length, 1);
  assert.equal(snapshots.get('history')[0].index, 1);
  assert.equal(JSON.stringify(snapshots.get('history')).includes('完整翻译'), false);
  assert.equal(snapshots.get('memory')[0].source, 'memories');
  assert.equal(snapshots.get('memory')[0].content.includes('完整翻译'), true);
  assert.deepEqual(
    snapshots.get('full').map((item) => item.source),
    ['messages', 'memories'],
  );
});

test('skill content enters only the selected source view', async () => {
  const rows = [];
  for (const condition of ['input', 'skills']) rows.push(await runCase({ fixture: fixture('named-skill'), condition, model: { complete: async () => reply(select('apply_skill')) } }));
  assert.equal(rows[0].status, 'contract-error');
  assert.equal(rows[0].error.code, 'missing-material');
  assert.equal(rows[0].plan, undefined);
  assert.equal(rows[1].status, 'select');
  assert.equal(rows[1].material[0].instructions.includes('待确认事项'), true);
  assert.equal(rows[1].plan.node, 'apply_skill');
});

for (const [title, text, code] of [
  ['invalid JSON', 'not JSON', 'invalid-json'],
  ['unknown node', JSON.stringify(select('made_up')), 'unknown-node'],
  ['invented evidence', JSON.stringify(select('translate', ['messages:999'])), 'unknown-evidence'],
  ['extra fields', JSON.stringify({ ...select('translate'), debug: true }), 'invalid-shape'],
])
  test(`intent example rejects ${title} before invoking any candidate`, async () => {
    const row = await runCase({ fixture: fixtures[0], condition: 'input', model: { complete: async () => modelReply(text) } });
    assert.equal(row.status, 'contract-error');
    assert.equal(row.error.code, code);
    assert.equal(row.plan, undefined);
  });

test('finish reason, transport failure, and a valid but wrong choice remain distinct', async () => {
  const models = [
    { complete: async () => reply(select('translate'), { termination: { kind: 'incomplete', reason: 'length' } }) },
    {
      complete: async () => {
        throw new Error('provider response could contain a secret; do not print it');
      },
    },
    { complete: async () => reply(select('polish')) },
  ];
  const rows = [];
  for (const model of models) rows.push(await runCase({ fixture: fixtures[0], condition: 'input', model }));
  assert.deepEqual(
    rows.map((row) => row.status),
    ['contract-error', 'provider-error', 'select'],
  );
  assert.equal(rows[0].error.code, 'unfinished-output');
  assert.equal(rows[1].error.message, undefined);
  assert.equal(rows[2].matched, false);
  assert.equal(rows[2].plan.node, 'polish');
});

test('live matrix is bounded, makes no retries, and places expectations only in reports', async () => {
  let calls = 0;
  const model = {
    complete: async () => {
      calls++;
      return reply(select('made_up'));
    },
  };
  const report = await runMatrix({ fixtures, model, limit: 3 });
  assert.equal(calls, 3);
  assert.equal(report.rows.length, 3);
  assert.equal(
    report.rows.every((row) => row.status === 'contract-error'),
    true,
  );
  assert.equal(report.summary.input.contractErrors, 1);
  await assert.rejects(runMatrix({ fixtures, model, selectedConditions: ['other'] }));
  await assert.rejects(runMatrix({ fixtures, model, limit: Infinity }));
});

test('decision contract retains valid evidence and rejects missing-source actions', () => {
  const material = [{ ref: 'memories:0', source: 'memories', content: '简短中文' }];
  const accepted = acceptDecision(JSON.stringify(select('recall_memory', ['memories:0'])), material);
  assert.equal(accepted.evidence[0], 'memories:0');
  assert.throws(() => acceptDecision(JSON.stringify(select('recall_history')), material), { code: 'missing-material' });
});

test('offline CLI writes a requested report, refuses overwrite and validates flags before work', () => {
  const directory = mkdtempSync(join(tmpdir(), 'capix-intent-'));
  const target = join(directory, 'report.json');
  const cli = fileURLToPath(new URL('../examples/intent/run.mjs', import.meta.url));
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', stdio: 'pipe' });
  try {
    const output = run('--conditions', 'input', '--limit', '1', '--out', target);
    assert.equal(output, '');
    const report = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(report.mode, 'scripted-wiring-only');
    assert.equal(report.rows.length, 1);
    assert.throws(
      () => run('--out', target),
      (error) => error.stderr.includes('EEXIST') && !error.stderr.includes('explicit-translation /'),
    );
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).createdAt, report.createdAt);
    assert.throws(
      () => run('--limit', 'NaN'),
      (error) => error.stderr.includes('limit must be'),
    );
    assert.throws(
      () => run('--conditions', 'wrong'),
      (error) => error.stderr.includes('Invalid experiment conditions'),
    );
    assert.match(run('--help'), /Usage:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
