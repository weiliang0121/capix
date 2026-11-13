import assert from 'node:assert/strict';
import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { createNotesAssistant } from './assistant.mjs';
import { createMaterials } from './materials.mjs';
import { OfflineNotesProvider } from './offline-provider.mjs';

// 新操作复用原 Notes；不把查询结果复制到另一个内容所有者里。
const searching = new ResourceOffer({
  methods: {
    search(notes, query) {
      if (typeof query !== 'string' || !query.trim()) throw new TypeError('请输入非空关键词');
      const keyword = query.trim();
      return notes
        .keys()
        .map((id) => notes.read(id))
        .filter(({ value }) => value.title.includes(keyword) || value.text.includes(keyword));
    },
  },
});
const search = new Node({
  deps: { notes: searching.request() },
  run: (work) => work.resources.notes.search(work.input),
});

const materials = createMaterials();
const resources = new Resources().register(new Resource(materials.notes), searching);
const query = new Runner(new Scene(search), resources).build();
const assistant = createNotesAssistant(new OfflineNotesProvider(), materials.notes);
try {
  const before = await query.run('待办');
  assert.equal(before.length, 0);
  console.log(`助手运行前，搜索「待办」：${before.length} 条`);

  // 两个 Runner 共享内容实体，各自拥有自己的结构、申请与调用。
  await assistant.runner.run({ request: materials.request });
  const after = await query.run('待办');
  assert.equal(after.length, 1);
  assert.equal(after[0].value.title, '待办');
  assert.deepEqual(after[0], materials.notes.read(after[0].id));
  console.log(`助手运行后，搜索「待办」：${after.length} 条`);
  console.log(after[0].value.text);

  // 正文也参与查询；读取不修改实体，多个结果保留各自准确的身份。
  const matching = await query.run('演示');
  assert.equal(matching.length, 2);
  assert.ok(matching.some(({ id }) => id === materials.originals[0].id));
  assert.ok(matching.some(({ id }) => id === after[0].id));
  await assert.rejects(query.run('  '), /请输入非空关键词/u);
  assert.equal(materials.notes.keys().length, 3);
  for (const original of materials.originals) assert.deepEqual(materials.notes.read(original.id), original);
  assert.equal(query.isRunning, false);
  console.log('查询验证通过：同一实体、新的操作、独立调用；查询没有写入便签。');
} finally {
  await assistant.interactions.settled();
  assistant.interactions.close();
}
