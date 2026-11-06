import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

async function upstream(t, rounds = 1) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString());
    requests.push({ bytes: raw.length, body });
    const results = body.messages.filter((message) => message.role === 'tool');
    const calls = results.length < rounds ? [{ id: `call-${results.length}`, type: 'function', function: { name: 'save', arguments: JSON.stringify({ text: `value-${results.length}` }) } }] : undefined;
    const message = {
      role: 'assistant',
      content: calls
        ? null
        : 'Saved: ' +
          results
            .map((result) =>
              JSON.parse(result.content)
                .content.map((part) => part.text)
                .join(''),
            )
            .join(','),
      reasoning_content: 'fixed reasoning',
      ...(calls ? { tool_calls: calls } : {}),
    };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: `model-${results.length}`, model: 'fixture', choices: [{ index: 0, message, finish_reason: calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { requests, url: `http://127.0.0.1:${server.address().port}/chat/completions` };
}
function run(mode, db, url, effects) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['test/fixtures/conversation-tools-host.mjs', mode, db, url, effects], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (v) => (out += v));
    child.stderr.on('data', (v) => (err += v));
    child.on('error', reject);
    child.on('close', (code) => {
      try {
        resolve({ code, report: JSON.parse(out.trim()), err });
      } catch {
        reject(new Error(`Tool fixture failed ${code}: ${err} ${out}`));
      }
    });
  });
}
function files(t) {
  const dir = mkdtempSync(join(tmpdir(), 'capix-tools-process-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { db: join(dir, 'content.sqlite'), effects: join(dir, 'effects.jsonl') };
}

test('native Provider, SQLite exchanges and CP resume in a new process without repeating the accepted tool', async (t) => {
  const server = await upstream(t);
  const f = files(t);
  const stopped = await run('crash', f.db, server.url, f.effects);
  assert.equal(stopped.code, 73, stopped.err);
  assert.equal(server.requests.length, 1);
  const before = readFileSync(f.effects, 'utf8');
  const resumed = await run('resume', f.db, server.url, f.effects);
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(resumed.report.result, 'Saved: VALUE-0');
  assert.equal(readFileSync(f.effects, 'utf8'), before);
  assert.equal(server.requests.length, 2);
  assert.deepEqual(resumed.report.roots, ['succeeded']);
  const wire = server.requests[1].body.messages;
  assert.equal(wire[0].content, server.requests[0].body.messages[0].content);
  assert.equal(wire[1].tool_calls[0].id, 'call-0');
  assert.equal(wire[1].reasoning_content, 'fixed reasoning');
  assert.equal(wire[2].tool_call_id, 'call-0');
  assert.deepEqual(JSON.parse(wire[2].content), { status: 'ok', content: [{ kind: 'text', text: 'VALUE-0' }] });
  assert.equal(resumed.report.exchanges.entries.length, 2);
  assert.equal(resumed.report.exchanges.entries[0].receptions.length, 1);
});

test('production measurement separates CP images, synchronous saves and full Interaction requests', async (t) => {
  const server = await upstream(t, 3);
  const f = files(t);
  const completed = await run('normal', f.db, server.url, f.effects);
  assert.equal(completed.code, 0, completed.err);
  const rows = completed.report.measurements;
  const saves = rows.filter((row) => row.kind === 'save');
  const finishes = rows.filter((row) => row.kind === 'finish');
  const model = saves.filter((row) => row.contract === 'conversation.tools.completion');
  assert.equal(server.requests.length, 4);
  assert.equal(readFileSync(f.effects, 'utf8').trim().split('\n').length, 3);
  assert.ok(saves.length > 0 && finishes.length > 0);
  assert.ok(rows.every((row) => Number.isFinite(row.syncMs) && row.syncMs >= 0));
  for (const row of model) {
    assert.deepEqual(Object.keys(row.modelInput), ['exchanges']);
    assert.ok(!JSON.stringify(row.modelInput).includes('basis-'));
  }
  assert.equal(Math.max(...saves.filter((row) => row.contract === 'conversation.tools.loop').map((row) => row.children)), 7);
  assert.ok(Math.max(...saves.map((row) => row.bytes)) < 8 * 1024 * 1024);
  const report = { save: saves.length, finish: finishes.length, cpBytes: rows.reduce((n, row) => n + row.bytes, 0), largestImageBytes: Math.max(...saves.map((row) => row.bytes)), maxSyncMs: Math.max(...rows.map((row) => row.syncMs)), interactionRequestBytes: server.requests.map((row) => row.bytes) };
  t.diagnostic(JSON.stringify(report));
});

for (const changed of ['request', 'feedback'])
  test(`tool recovery refuses changed ${changed} without resending`, async (t) => {
    const server = await upstream(t);
    const f = files(t);
    const stopped = await run('crash-model', f.db, server.url, f.effects);
    assert.equal(stopped.code, 73, stopped.err);
    assert.equal(server.requests.length, 1);
    const database = new DatabaseSync(f.db);
    const row = database.prepare('SELECT * FROM completion_interactions').get();
    const state = JSON.parse(row.body);
    if (changed === 'request') state.request.messages[0].content = 'changed original material';
    else {
      delete state.feedback;
      state.revision = 1;
    }
    database.prepare('UPDATE completion_interactions SET revision = ?, body = ? WHERE id = ?').run(state.revision, JSON.stringify(state), state.id);
    database.close();
    const refused = await run('resume', f.db, server.url, f.effects);
    assert.equal(refused.code, 1, refused.err);
    assert.equal(refused.report.status, 'failed');
    assert.equal(server.requests.length, 1);
  });
