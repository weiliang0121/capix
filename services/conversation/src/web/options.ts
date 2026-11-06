import { resolveConversationOutputBudget } from '../model/budget.js';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { parseAnswerMode } from '../hosting/options.js';

export const usage = `Usage: pnpm conversation:web [--demo | --live] [--db PATH] [--port PORT]

浏览器中的单会话装配，默认离线演示，地址 http://127.0.0.1:4318。
--live 显式启用真实 DeepSeek；需要环境变量 DEEPSEEK_API_KEY。
--answer-mode material|tools 选择材料回答或原生工具调用，默认 material，与 demo/live 独立。
默认数据：演示 .capix/conversation-demo.sqlite，真实 .capix/conversation.sqlite。
同一数据库只能由一个 CLI 或 Web 进程打开；请先退出对应 CLI。
消息、记忆、View 跨重启保存；提交接回和调用记录仅限本进程。
--answer-tokens / --memory-tokens 设置每次回答/提取的输出 token 上限，默认4096/8192。
上限不是保证完成；恢复时必须使用原预算。
程序不读取 .env，可由启动命令显式加载；Ctrl-C 正常关闭。`;

export function parseWebOptions(args: readonly string[]) {
  const { values } = parseArgs({ args: [...args], options: { demo: { type: 'boolean' }, live: { type: 'boolean' }, db: { type: 'string' }, port: { type: 'string' }, 'answer-mode': { type: 'string' }, 'answer-tokens': { type: 'string' }, 'memory-tokens': { type: 'string' }, help: { type: 'boolean' } } });
  for (const name of ['answer-tokens', 'memory-tokens'] as const) {
    if (values[name] !== undefined && !/^[1-9]\d*$/.test(values[name])) throw new Error(`--${name} requires a positive integer`);
  }
  const outputBudget = resolveConversationOutputBudget({ answer: values['answer-tokens'] === undefined ? undefined : Number(values['answer-tokens']), memory: values['memory-tokens'] === undefined ? undefined : Number(values['memory-tokens']) });
  if (values.demo && values.live) throw new Error('Choose either --demo or --live');
  if (values.db !== undefined && !values.db.trim()) throw new Error('--db requires a nonempty path');
  const port = Number(values.port ?? 4318);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || (values.port !== undefined && !/^\d+$/.test(values.port))) throw new Error('--port must be an integer between 1 and 65535');
  return { mode: values.live ? ('live' as const) : ('demo' as const), answerMode: parseAnswerMode(values['answer-mode']), database: resolve(values.db ?? (values.live ? '.capix/conversation.sqlite' : '.capix/conversation-demo.sqlite')), port, outputBudget, help: values.help ?? false };
}
