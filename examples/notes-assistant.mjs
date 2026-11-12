import { pathToFileURL } from 'node:url';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { createNotesAssistant } from './notes/assistant.mjs';
import { createMaterials } from './notes/materials.mjs';
import { OfflineNotesProvider } from './notes/offline-provider.mjs';

class ConfigurationError extends Error {}

export async function main(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && !['--help', '--live'].includes(args[0]))) throw new ConfigurationError('参数只支持 --help 或 --live。');
  if (args[0] === '--help') {
    console.log('用法：node examples/notes-assistant.mjs [--help | --live]\n默认：离线固定决策脚本（不是智能模型），只使用内存便签。\n--live：真实模型调用；必须提供 MODEL_ENDPOINT、MODEL_NAME、MODEL_API_KEY。\n不读取 .env；不保存到磁盘，不设置 checkpoint。');
    return;
  }
  const live = args[0] === '--live';
  let provider;
  if (live) {
    const endpoint = process.env.MODEL_ENDPOINT;
    const model = process.env.MODEL_NAME;
    const apiKey = process.env.MODEL_API_KEY;
    if (![endpoint, model, apiKey].every((value) => typeof value === 'string' && value.trim())) throw new ConfigurationError('--live 必须提供 MODEL_ENDPOINT、MODEL_NAME、MODEL_API_KEY。');
    // 配置错误不回显 endpoint、模型名或密钥；本入口不读取环境文件。
    try {
      provider = new ChatCompletionsProvider({ endpoint, model, apiKey });
    } catch {
      throw new ConfigurationError('真实模型配置无效，请检查 MODEL_ENDPOINT、MODEL_NAME、MODEL_API_KEY。');
    }
  } else provider = new OfflineNotesProvider();

  const materials = createMaterials();
  console.log(live ? '真实模型模式；便签仅在内存中。' : '离线模式：固定决策脚本，不是智能模型；便签仅在内存中。');
  const events = [];
  // #region run
  const { runner, interactions } = createNotesAssistant(provider, materials.notes, {
    onRead(note) {
      events.push({ kind: 'read', note });
      console.log(`readNote 成功：${note.value.title}\n${note.value.text}`);
    },
    onWrite(note) {
      events.push({ kind: 'write', note });
      console.log(`writeNote 成功：${note.value.title}\n${note.value.text}`);
    },
  });
  try {
    const answer = await runner.run({ request: materials.request });
    const readIds = events.filter(({ kind }) => kind === 'read').map(({ note }) => note.id);
    if (materials.originals.some(({ id }) => !readIds.includes(id)) || events.filter(({ kind }) => kind === 'write').length !== 1) throw new Error('便签助手没有读完两张原便签并完成一次写入。');
    console.log(`最终回答：\n${answer}`);
    console.log('本次新增便签：');
    for (const { note } of events.filter(({ kind }) => kind === 'write')) console.log(JSON.stringify(note, null, 2));
  } finally {
    // CLI 只有这一次入口，不再发起新调用；等待宿主持有的独立发送退出再关闭。
    await interactions.settled();
    interactions.close();
  }
  // #endregion run
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    // 真实网络/服务错误可能携带请求信息，真实模式不原样输出。
    console.error(process.argv.slice(2).includes('--live') && !(error instanceof ConfigurationError) ? '便签助手失败：真实模型或工具调用未完成。' : `便签助手失败：${error.message}`);
    process.exitCode = 1;
  }
}
