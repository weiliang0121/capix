import { parseArgs } from 'node:util';
import { resolve } from 'node:path';

export const usage = `Usage: pnpm conversation:web [--demo | --live] [--db PATH] [--port PORT]

浏览器中的单会话装配，默认离线演示，地址 http://127.0.0.1:4318。
--live 显式启用真实 DeepSeek；需要环境变量 DEEPSEEK_API_KEY。
默认数据：演示 .capix/conversation-demo.sqlite，真实 .capix/conversation.sqlite。
同一数据库只能由一个 CLI 或 Web 进程打开；请先退出对应 CLI。
消息、记忆、View 跨重启保存；提交接回和调用记录仅限本进程。
程序不读取 .env，可由启动命令显式加载；Ctrl-C 正常关闭。`;

export function parseWebOptions(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], options: { demo: { type: 'boolean' }, live: { type: 'boolean' }, db: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.demo && values.live) throw new Error('Choose either --demo or --live');
  if (values.db !== undefined && !values.db.trim()) throw new Error('--db requires a nonempty path');
  const port = Number(values.port ?? 4318);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || (values.port !== undefined && !/^\d+$/.test(values.port))) throw new Error('--port must be an integer between 1 and 65535');
  return { mode: values.live ? ('live' as const) : ('demo' as const), database: resolve(values.db ?? (values.live ? '.capix/conversation.sqlite' : '.capix/conversation-demo.sqlite')), port, help: values.help ?? false };
}
