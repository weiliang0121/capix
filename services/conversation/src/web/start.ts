import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHostModel } from '../hosting/model.js';
import { failureLabel } from '../hosting/diagnostic.js';
import { createConversationWebHost } from './host.js';
import { parseWebOptions, usage } from './options.js';

try {
  const options = parseWebOptions(process.argv.slice(2));
  if (options.help) console.log(usage);
  else {
    const assetsDirectory = fileURLToPath(new URL('../../../../apps/observer/dist', import.meta.url));
    await access(join(assetsDirectory, 'conversation.html'));
    const model = createHostModel(options.mode);
    const host = createConversationWebHost({ ...options, model, modelName: options.mode === 'demo' ? 'offline-demo' : process.env.DEEPSEEK_MODEL || 'deepseek-flash', assetsDirectory });
    let stop: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        host.server.once('error', reject);
        host.server.listen(options.port, '127.0.0.1', () => {
          host.server.off('error', reject);
          resolve();
        });
      });
      console.log(`CAPiX 对话：http://127.0.0.1:${options.port}（${options.mode === 'demo' ? '离线演示' : '真实模型'}）`);
      console.log('消息、记忆和 View 自动保存；调用记录与提交接回仅限本进程。');
      await new Promise<void>((resolve) => {
        stop = resolve;
        // Repeated signals during cleanup must not kill the independent sender mid-save.
        process.on('SIGINT', stop);
        process.on('SIGTERM', stop);
      });
    } finally {
      try {
        console.log('正在结束本地调用并等待独立模型请求完成……');
        await host.close();
      } finally {
        if (stop) {
          process.off('SIGINT', stop);
          process.off('SIGTERM', stop);
        }
      }
    }
  }
} catch (error) {
  console.error(`无法运行对话服务：${failureLabel(error)}。请检查构建产物、端口、模型配置，以及该数据库是否仍被 CLI 使用。`);
  process.exitCode = 1;
}
