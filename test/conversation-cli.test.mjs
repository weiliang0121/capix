import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile, access, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { RecordBook } from '@capix/records';

const entry = fileURLToPath(new URL('../services/conversation/dist/start.js', import.meta.url));

function cli(args, { input = '', env = {}, imports = [], onOutput, cwd } = {}) {
  const child = spawn(process.execPath, [...imports.flatMap((path) => ['--import', path]), entry, ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, DEEPSEEK_API_KEY: '', ...env } });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => {
    stdout += data;
    onOutput?.(stdout, child);
  });
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') throw error;
  });
  child.stdin.end(input);
  return completed;
}

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'capix-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function load(path) {
  const store = ConversationStore.open(path);
  try {
    return store.load();
  } finally {
    store.close();
  }
}

test('conversation CLI persists one complete chain and a new process consumes its restored memory', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'conversation.sqlite');
  const records = join(directory, 'records.json');
  const first = await cli(['--demo', '--db', path, '--records', records, '--input', '请使用简短中文']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /离线演示/);
  assert.match(first.stdout, /预览：/);
  assert.match(first.stdout, /正式回答：/);
  const before = load(path);
  assert.equal(before.transcript.messages.length, 2);
  assert.equal(before.memories.items.length, 1);
  assert.equal(before.view.members.length, 3);
  const archive = JSON.parse(await readFile(records, 'utf8'));
  assert.equal(archive.format, 'capix.conversation.recording');
  assert.equal(archive.version, 1);
  assert.equal(archive.integrity, 'intact');
  assert.match(archive.recorderId, /^[0-9a-f-]{36}$/);
  assert.equal((await stat(records)).mode & 0o777, 0o600);
  const book = RecordBook.restore(archive.book);
  assert.equal(book.get(archive.rootId).kind, 'runtime');
  const calls = archive.book.entries.filter((record) => record.kind === 'invocation');
  assert.ok(calls.length > 3);
  assert.ok(calls.every((record) => record.data.status === 'succeeded'));
  const transcript = archive.book.entries.filter((record) => record.kind === 'transcript');
  assert.deepEqual(
    transcript.map((record) => record.data.value),
    [
      { action: 'append', start: 0, end: 1 },
      { action: 'append', start: 1, end: 2 },
    ],
  );
  const memories = archive.book.entries.filter((record) => record.kind === 'memory');
  assert.equal(memories.length, 1);
  assert.equal(memories[0].data.memoryId, before.memories.items[0].id);
  for (const record of [...transcript, ...memories]) {
    const parent = book.get(record.data.parentId);
    assert.equal(parent.kind, 'invocation');
    assert.equal(parent.contextId, record.data.contextId);
    assert.ok(parent.childIds.includes(record.data.id));
  }
  const second = await cli(['--db', path, '--input', '我之前说了什么？']);
  assert.equal(second.code, 0, second.stderr);
  assert.match(second.stdout, /状态：消息 2，记忆 1，View 成员 3/);
  assert.match(second.stdout, /已有活跃记忆：“请使用简短中文”/);
  const after = load(path);
  assert.equal(after.transcript.id, before.transcript.id);
  assert.equal(after.memories.id, before.memories.id);
  assert.equal(after.memories.items[0].id, before.memories.items[0].id);
  assert.equal(after.transcript.messages.length, 4);
  assert.equal(after.memories.items[0].content, '我之前说了什么？');
  assert.deepEqual(after.memories.items[0].sourceIndexes, [2]);
  assert.equal(after.view.members.length, 5);
  assert.equal(await readFile(records, 'utf8'), `${JSON.stringify(archive)}\n`, 'the next process does not alter the prior record export');
});

test('piped conversation input survives EOF, commands do not become formal messages', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'conversation.sqlite');
  const result = await cli(['--db', path], { input: '第一条\n第二条\n/status\n/exit\n不得执行\n' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((result.stdout.match(/正式回答：/g) ?? []).length, 2);
  assert.match(result.stdout, /状态：消息 4，记忆 1，View 成员 5/);
  assert.deepEqual(
    load(path)
      .transcript.messages.filter((message) => message.role === 'user')
      .map((message) => message.content),
    ['第一条', '第二条'],
  );
});

test('the default offline database is separate from the real conversation database', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const result = await cli(['--input', '演示材料'], { cwd: directory });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(load(join(directory, '.capix', 'conversation-demo.sqlite')).transcript.messages.length, 2);
  await assert.rejects(access(join(directory, '.capix', 'conversation.sqlite')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(join(directory, '.capix')), ['conversation-demo.sqlite']);
});

test('invalid mode and missing live configuration fail before creating a database', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'conversation.sqlite');
  for (const args of [['--demo', '--live'], ['--live'], ['--unknown'], ['--records', '   ']]) {
    const result = await cli([...args, '--db', path, '--input', 'not accepted']);
    assert.equal(result.code, 1);
    await assert.rejects(access(path), { code: 'ENOENT' });
  }
  const help = await cli(['--help', '--db', path]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /--live/);
  assert.match(help.stdout, /--records/);
  await assert.rejects(access(path), { code: 'ENOENT' });
});

test('SIGTERM cancels local delivery but drains the independent sender before closing storage', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'conversation.sqlite');
  const records = join(directory, 'records.json');
  const transport = join(directory, 'transport.mjs');
  // Explicit offline transport injection. No real endpoint or credential is contacted.
  await writeFile(
    transport,
    `
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) {
    const emit = value => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(value) + '\\n\\n'));
    emit({id:'fixture',model:'fixture',choices:[{index:0,delta:{content:'preview'},finish_reason:null}]});
    setTimeout(() => {
      emit({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]});
      controller.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));
      controller.close();
      process.stdout.write('\\nfixture sender settled\\n');
    }, 500);
  }
}), {headers:{'content-type':'text/event-stream'}});
`,
  );
  let signalled = false;
  const result = await cli(['--live', '--db', path, '--records', records, '--input', '取消这一条'], {
    imports: [transport],
    env: { DEEPSEEK_API_KEY: 'offline-fixture-key' },
    onOutput(output, child) {
      if (!signalled && output.includes('预览：')) {
        signalled = true;
        child.kill('SIGTERM');
      }
    },
  });
  assert.equal(signalled, true);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.code, 143, result.stderr);
  assert.match(result.stdout, /fixture sender settled/);
  assert.doesNotMatch(result.stdout, /正式回答：/);
  assert.doesNotMatch(result.stdout + result.stderr, /offline-fixture-key/);
  assert.deepEqual(load(path).transcript.messages, [{ role: 'user', content: '取消这一条' }]);
  const archive = JSON.parse(await readFile(records, 'utf8'));
  assert.equal(archive.integrity, 'intact', 'a cancelled call does not itself invalidate recording');
  RecordBook.restore(archive.book);
  assert.ok(archive.book.entries.some((record) => record.kind === 'invocation' && record.data.status === 'failed'));
});

test('record paths are reserved before input and never overwrite the database, directories or existing files', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const database = join(directory, 'conversation.sqlite');
  const store = ConversationStore.open(database);
  store.close();
  const before = await readFile(database);
  const existing = join(directory, 'existing.json');
  await writeFile(existing, 'keep this file');
  for (const records of [database, `${database}-wal`, `${database}-shm`, directory, existing]) {
    const result = await cli(['--db', database, '--records', records, '--input', '不得接纳']);
    assert.equal(result.code, 1, result.stdout);
    assert.doesNotMatch(result.stdout, /正式回答：/);
    assert.deepEqual(await readFile(database), before);
  }
  assert.equal(await readFile(existing, 'utf8'), 'keep this file');
  const alias = join(directory, 'alias');
  await symlink(directory, alias, 'dir');
  const fresh = join(directory, 'fresh.sqlite');
  const result = await cli(['--db', fresh, '--records', join(alias, 'fresh.sqlite'), '--input', '不得接纳']);
  assert.equal(result.code, 1);
  await assert.rejects(access(fresh), { code: 'ENOENT' });
});

test('an isolated recording failure marks the export incomplete while accepted content remains successful', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const database = join(directory, 'conversation.sqlite');
  const records = join(directory, 'records.json');
  const injection = join(directory, 'record-failure.mjs');
  await writeFile(
    injection,
    `
import {Recorder} from ${JSON.stringify(import.meta.resolve('@capix/records'))};
const add = Recorder.prototype.add;
Recorder.prototype.add = function(record) {
  if (record.kind === 'resource') throw new Error('fixture record sink failed');
  return add.call(this, record);
};
`,
  );
  const result = await cli(['--db', database, '--records', records, '--input', '业务仍然完成'], { imports: [injection] });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /正式回答：/);
  assert.equal(load(database).transcript.messages.length, 2);
  const archive = JSON.parse(await readFile(records, 'utf8'));
  assert.equal(archive.integrity, 'incomplete');
  assert.equal(RecordBook.restore(archive.book).get(archive.rootId).kind, 'runtime');
  const disabled = await cli(['--db', database, '--input', '关闭记录继续'], { imports: [injection] });
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.doesNotMatch(disabled.stderr, /记录/);
});

test('record export failure reports failure, preserves accepted content and closes file and store', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const database = join(directory, 'conversation.sqlite');
  const records = join(directory, 'records.json');
  const marker = join(directory, 'closed.json');
  const injection = join(directory, 'file-failure.mjs');
  await writeFile(
    injection,
    `
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {ConversationStore} from ${JSON.stringify(import.meta.resolve('@capix/conversation-service/persistence'))};
const write = fs.writeFileSync;
const open = fs.openSync;
const close = fs.closeSync;
const closeStore = ConversationStore.prototype.close;
let descriptor;
let storeClosed = false;
fs.openSync = (...args) => {
  const result = open(...args);
  if (args[0] === ${JSON.stringify(records)}) descriptor = result;
  return result;
};
fs.writeFileSync = (...args) => {
  if (args[0] === descriptor) throw Object.assign(new Error('fixture export failed'), {code:'ENOSPC'});
  return write(...args);
};
ConversationStore.prototype.close = function() {
  closeStore.call(this);
  storeClosed = true;
};
fs.closeSync = fd => {
  close(fd);
  if (fd === descriptor) write(${JSON.stringify(marker)}, JSON.stringify({fileClosed:true,storeClosed}));
};
syncBuiltinESMExports();
`,
  );
  const result = await cli(['--db', database, '--records', records, '--input', '内容已接纳'], { imports: [injection] });
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stdout, /正式回答：/);
  assert.match(result.stderr, /fixture export failed/);
  assert.equal(load(database).transcript.messages.length, 2);
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { fileClosed: true, storeClosed: true });
  assert.equal(await readFile(records, 'utf8'), '', 'failed export is not presented as a complete archive');
});

test('ordinary model failure preserves input and allows the next piped submission without retrying', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'conversation.sqlite');
  const transport = join(directory, 'transport.mjs');
  await writeFile(
    transport,
    `
let count = 0;
globalThis.fetch = async (_url, init) => {
  count++;
  process.stdout.write('fixture request ' + count + '\\n');
  if (count === 1) return new Response('', {status:503});
  const request = JSON.parse(init.body);
  if (!request.stream) return Response.json({id:'memory',model:'fixture',choices:[{index:0,message:{role:'assistant',content:'{"changes":[]}'},finish_reason:'stop'}],usage:null});
  const chunks = [
    {id:'answer',model:'fixture',choices:[{index:0,delta:{content:'候选内容'},finish_reason:null}]},
    {id:'answer',model:'fixture',choices:[{index:0,delta:{content:'。'},finish_reason:'stop'}]},
  ];
  return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\\n\\n').join('') + 'data: [DONE]\\n\\n', {headers:{'content-type':'text/event-stream'}});
};
`,
  );
  const result = await cli(['--live', '--db', path], { input: '第一次失败\n第二次成功\n', imports: [transport], env: { DEEPSEEK_API_KEY: 'offline-fixture-key' } });
  assert.equal(result.code, 1, 'the process reports a failed submission even after later success');
  assert.equal((result.stdout.match(/fixture request /g) ?? []).length, 3, result.stdout);
  assert.equal((result.stdout.match(/正式回答：/g) ?? []).length, 1, result.stdout);
  assert.match(result.stderr, /本次未完成/);
  assert.deepEqual(load(path).transcript.messages, [
    { role: 'user', content: '第一次失败' },
    { role: 'user', content: '第二次成功' },
    { role: 'assistant', content: '候选内容。' },
  ]);
});

test('a broken output pipe stops new inputs and drains the external sender before closing', { timeout: 20_000 }, async (t) => {
  const directory = await temporary(t);
  const path = join(directory, 'conversation.sqlite');
  const marker = join(directory, 'sender-settled');
  const transport = join(directory, 'transport.mjs');
  await writeFile(
    transport,
    `
import {writeFileSync} from 'node:fs';
globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) {
    const emit = value => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(value) + '\\n\\n'));
    emit({id:'fixture',model:'fixture',choices:[{index:0,delta:{content:'preview'},finish_reason:null}]});
    setTimeout(() => emit({id:'fixture',model:'fixture',choices:[{index:0,delta:{content:'next'},finish_reason:null}]}), 100);
    setTimeout(() => {
      emit({id:'fixture',model:'fixture',choices:[{index:0,delta:{},finish_reason:'stop'}]});
      controller.enqueue(new TextEncoder().encode('data: [DONE]\\n\\n'));
      controller.close();
      writeFileSync(${JSON.stringify(marker)}, 'settled');
    }, 500);
  }
}), {headers:{'content-type':'text/event-stream'}});
`,
  );
  let disconnected = false;
  const result = await cli(['--live', '--db', path], {
    input: '第一条\n不得继续\n',
    imports: [transport],
    env: { DEEPSEEK_API_KEY: 'offline-fixture-key' },
    onOutput(output, child) {
      if (!disconnected && output.includes('预览：')) {
        disconnected = true;
        child.stdout.destroy();
      }
    },
  });
  assert.equal(disconnected, true);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.equal(await readFile(marker, 'utf8'), 'settled');
  assert.deepEqual(load(path).transcript.messages, [{ role: 'user', content: '第一条' }]);
});
