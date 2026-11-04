import { parseArgs } from 'node:util';
import { scenario } from './scenario.mjs';
import { createFixtureModel, createLiveModel } from './model.mjs';
import { runStudy } from './study.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean', default: false }, turns: { type: 'string', default: '54' }, out: { type: 'string' }, help: { type: 'boolean', default: false } } });
if (values.help || !values.out) {
  console.log('Usage: node examples/long-conversation/run.mjs --out NEW_DIRECTORY [--turns 24|36|54] [--live]\n默认离线固定模型；新建独立数据库与报告，不覆盖旧目录。\n--live 使用环境中的 DEEPSEEK_API_KEY / DEEPSEEK_MODEL，最多 2×提交数次请求，不重试；脚本不读取 .env。\n24/36/54 次统计检查点，继续时关闭并重开内容；这不是 CP 崩溃恢复测试。');
  if (!values.help) process.exitCode = 1;
} else {
  const count = Number(values.turns);
  if (![24, 36, 54].includes(count)) throw new Error('--turns must be 24, 36 or 54');
  let provider = createFixtureModel(scenario.turns);
  let modelName = 'offline-long-conversation';
  if (values.live) {
    let measureBody;
    const live = createLiveModel((bytes) => measureBody?.(bytes));
    modelName = live.name;
    provider = {
      complete(request, controls, measure) {
        measureBody = measure;
        return live.provider.complete(request, controls);
      },
    };
  }
  const summary = await runStudy({ scenario, provider, mode: values.live ? 'live' : 'offline', modelName, out: values.out, count, onProgress: (row) => console.log(`${row.number}/${count} ${row.topic} ${row.failure ? 'failed' : 'saved'} · ${Math.round(row.elapsedMs)}ms · memory ${row.content.memories} · CP ${Math.round(row.checkpoints.imageBytes / 1024)}KiB`) });
  console.log(`完成 ${summary.completed}/${summary.planned}，模型调用 ${summary.modelCalls}，报告：${values.out}/report.md`);
  if (!summary.complete) process.exitCode = 1;
}
