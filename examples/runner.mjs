import { Scene, Node, ResourceOffer, Resources, Runner } from '@capix/server-runtime';

// 定义访问形式：实体属于宿主，端点的每次使用受本次调用窗口约束。
const dictionary = new ResourceOffer('dictionary.read', (entries, access) => ({
  translate: (word) => access.runSync('translate', { word }, () => entries.get(word) ?? word),
}));
const resources = new Resources().register(dictionary, new Map([['hello', '你好']]));

// Node 只知道自己申请的端点；不用知道实体从哪里来、怎样接线。
const translate = new Node();
translate.setRun({ requires: { dictionary: dictionary.request() }, execute: (work) => work.resources.dictionary.translate(work.input) });
const scene = new Scene().add(translate);
scene.setRun({
  async execute(work) {
    const call = work.children.create(translate, work.input);
    await call.run();
    return call.accept();
  },
});

// build 只固定结构和接线；run 才创建调用。没有 Source、providers 或 readyScene。
const runner = new Runner(scene, resources).build();
console.log(await runner.run('hello')); // 你好
