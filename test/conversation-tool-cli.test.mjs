import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ConversationStore } from '@capix/conversation-service/persistence';

async function cli(database, args = [], input = '') {
  const child = spawn(process.execPath, ['services/conversation/dist/start.js', '--demo', '--db', database, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_API_KEY: '' } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (value) => {
    stdout += value;
  });
  child.stderr.on('data', (value) => {
    stderr += value;
  });
  child.stdin.end(input);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

test('CLI tools mode runs real history nodes, keeps separate archives and reopens without loading prior loops', { timeout: 30_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-tool-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'tools.sqlite');
  const first = await cli(database, ['--answer-mode', 'tools'], '客户代号是青松\n青松\n/status\n/exit\n');
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /执行工具 search_history/);
  assert.match(first.stdout, /执行工具 read_message/);
  assert.match(first.stdout, /历史消息 #0/);
  assert.doesNotMatch(first.stdout, /预览：/);
  const store = ConversationStore.open(database);
  let original;
  try {
    assert.equal(store.load().transcript.messages.length, 4);
    original = store.exchanges.list().items;
    assert.equal(original.length, 2);
    assert.equal(new Set(original.map((entry) => entry.id)).size, 2);
    assert.ok(original.every((entry) => entry.metadata?.source.transcriptId === store.load().transcript.id));
    assert.ok(store.checkpoints.listRoots().every((head) => head.image.contract.key === 'conversation.tools.scene' && head.delivery?.status === 'succeeded'));
  } finally {
    store.close();
  }
  const reopened = await cli(database, ['--answer-mode', 'tools', '--input', '青松']);
  assert.equal(reopened.code, 0, reopened.stderr);
  assert.match(reopened.stdout, /历史消息 #0/);
  const next = ConversationStore.open(database);
  try {
    assert.equal(next.load().transcript.messages.length, 6);
    assert.equal(next.exchanges.list().items.length, 3);
    for (const item of original) assert.equal(next.exchanges.load(item.id).state.sequence, item.sequence);
  } finally {
    next.close();
  }
});

test('CLI answer mode is explicit, independent of live/demo, and invalid modes do not open storage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'capix-tool-cli-options-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const database = join(directory, 'must-not-exist.sqlite');
  const invalid = await cli(database, ['--answer-mode', 'unknown', '--input', 'no']);
  assert.notEqual(invalid.code, 0);
  await assert.rejects(access(database));
  const help = await cli(database, ['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /answer-mode/);
  await assert.rejects(access(database));
});
