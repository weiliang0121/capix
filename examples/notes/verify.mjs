import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createNotesAssistant } from './assistant.mjs';
import { createMaterials } from './materials.mjs';
import { OfflineNotesProvider } from './offline-provider.mjs';
import { verifyNotesCli } from './verify-cli.mjs';

// 验证与离线替身独立于读者的 Node / Tool 定义。
export function verifyOfflineRun({ notes, originals }, provider, answer, events) {
  assert.equal(provider.requests.length, 4);
  assert.deepEqual(
    events.map(({ kind }) => kind),
    ['read', 'read', 'write'],
  );
  assert.deepEqual(
    events.slice(0, 2).map(({ note }) => note),
    originals,
  );
  assert.equal(notes.keys().length, 3);
  const created = events[2].note;
  const expected = {
    title: '待办',
    text: originals
      .flatMap(({ value }) =>
        value.text
          .split(/[；;]/u)
          .map((task) => task.trim())
          .filter(Boolean)
          .map((task) => `- ${task}`),
      )
      .join('\n'),
  };
  assert.deepEqual(created.value, expected);
  assert.deepEqual(notes.read(created.id), created);
  assert.equal(answer, `已创建便签「待办」：\n${expected.text}`);
  for (const original of originals) assert.deepEqual(notes.read(original.id), original);
  // 追加另一张便签不会改变已经取得的材料；正式内容已固定。
  const previous = structuredClone(created);
  assert.throws(() => {
    created.value.text = '篡改';
  }, TypeError);
  const candidate = { title: '额外材料', text: '原值' };
  const extra = notes.append(candidate);
  candidate.text = '变更后的输入';
  assert.equal(extra.value.text, '原值');
  assert.deepEqual(created, previous);
  assert.equal(provider.requests[3].exchanges[2].feedback[0].content[0].text, JSON.stringify(previous));
}

async function runOffline(materials, provider = new OfflineNotesProvider()) {
  const events = [];
  const app = createNotesAssistant(provider, materials.notes, { onRead: (note) => events.push({ kind: 'read', note }), onWrite: (note) => events.push({ kind: 'write', note }) });
  try {
    const answer = await app.runner.run({ request: materials.request });
    assert.equal(app.runner.isRunning, false);
    return { answer, provider, events };
  } finally {
    await app.interactions.settled();
    app.interactions.close();
  }
}

export async function verifyNotesAssistant() {
  const materials = createMaterials();
  const first = await runOffline(materials);
  verifyOfflineRun(materials, first.provider, first.answer, first.events);
  const changed = createMaterials([
    { title: '采购', text: '购买电池' },
    { title: '准备', text: '打印清单；装好设备' },
  ]);
  const second = await runOffline(changed);
  verifyOfflineRun(changed, second.provider, second.answer, second.events);
  assert.notEqual(first.answer, second.answer);

  // 合法 UUID 但实体不存在：读取失败不得变成最终成功或触发写入。
  const missing = createMaterials();
  const user = JSON.parse(missing.request.messages[1].content);
  user.notes[0].id = '00000000-0000-4000-8000-000000000000';
  missing.request.messages[1].content = JSON.stringify(user);
  await assert.rejects(runOffline(missing), /Note does not exist/u);
  assert.equal(missing.notes.keys().length, 2);

  // 参数不合法会收到明确的工具错误反馈；脚本必须拒绝继续伪造成功。
  const invalid = createMaterials();
  const invalidUser = JSON.parse(invalid.request.messages[1].content);
  invalidUser.notes[0].id = 'not-a-uuid';
  invalid.request.messages[1].content = JSON.stringify(invalidUser);
  await assert.rejects(runOffline(invalid), /invalid or failed tool feedback/u);
  assert.equal(invalid.notes.keys().length, 2);

  // 写入错误沿调用真实失败；已成功读取也不足以证明创建完成。
  const rejected = createMaterials();
  rejected.notes.append = () => {
    throw new Error('Example write rejected');
  };
  await assert.rejects(runOffline(rejected), /Example write rejected/u);
  assert.equal(rejected.notes.keys().length, 2);

  // 新便签已经写入后，最终回答发送失败不会回滚该业务事实，也不隐式重试。
  const undelivered = createMaterials();
  const script = new OfflineNotesProvider();
  const attempts = [];
  const writes = [];
  const failingFinalReply = {
    async complete(request) {
      attempts.push(request);
      if (attempts.length === 4) throw new Error('Final reply unavailable');
      return script.complete(request);
    },
  };
  const app = createNotesAssistant(failingFinalReply, undelivered.notes, { onWrite: (note) => writes.push(note) });
  try {
    await assert.rejects(app.runner.run({ request: undelivered.request }), /Final reply unavailable/u);
    assert.equal(app.runner.isRunning, false);
  } finally {
    await app.interactions.settled();
    assert.equal(app.interactions.active, false);
    app.interactions.close();
  }
  assert.equal(attempts.length, 4);
  assert.equal(script.requests.length, 3);
  assert.equal(writes.length, 1);
  assert.equal(undelivered.notes.keys().length, 3);
  assert.deepEqual(writes[0].value, { title: '待办', text: '- 整理用户反馈\n- 发送演示链接\n- 检查安装步骤' });
  assert.deepEqual(undelivered.notes.read(writes[0].id), writes[0]);
  assert.deepEqual(JSON.parse(attempts[3].exchanges[2].feedback[0].content[0].text), writes[0]);
  for (const original of undelivered.originals) assert.deepEqual(undelivered.notes.read(original.id), original);
  await verifyNotesCli();
  console.log('便签助手验证通过：读取、写入、回答、固定值、换素材及失败分支。');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await verifyNotesAssistant();
