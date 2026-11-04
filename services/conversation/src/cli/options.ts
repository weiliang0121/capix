import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

export interface ConversationCliOptions {
  readonly mode: 'demo' | 'live';
  readonly database: string;
  readonly records?: string;
  readonly input?: string;
  readonly resume?: string;
  readonly help: boolean;
}

export const usage = `Usage: pnpm conversation [--demo | --live] [--db PATH] [--records PATH] [--input TEXT | --resume CONTEXT_ID]

默认是离线演示，不访问模型。--live 显式启用真实 DeepSeek 请求。
--db 默认离线 .capix/conversation-demo.sqlite、真实 .capix/conversation.sqlite。
每个库保存一个对话的内容、checkpoint 与完整模型交互；显式 --db 可选择其他位置。
--records PATH 可选导出本进程调用记录；退出时写入新文件，不覆盖已有文件。
记录只在内存中收集，不提供崩溃恢复；默认不建立或导出记录。
--input 执行一条输入后退出；--resume 显式续接未终结且依据匹配的 checkpoint。
否则逐行对话，支持 /status、/recoveries、/resume CONTEXT_ID、/exit。
恢复不自动重发原模型请求；没有保存反馈时拒绝继续。
Ctrl-C 停止当前调用；空闲时退出。外部模型请求仍由宿主等到结束。
真实模式需要 DEEPSEEK_API_KEY，可选 DEEPSEEK_MODEL（默认 deepseek-flash）。
程序不读取 .env；可由启动命令显式加载。`;

export function parseConversationOptions(args: readonly string[]): ConversationCliOptions {
  const { values } = parseArgs({ args: [...args], options: { demo: { type: 'boolean' }, live: { type: 'boolean' }, db: { type: 'string' }, records: { type: 'string' }, input: { type: 'string' }, resume: { type: 'string' }, help: { type: 'boolean' } } });
  if (values.demo && values.live) throw new Error('Choose either --demo or --live');
  if (values.db !== undefined && !values.db.trim()) throw new Error('--db requires a nonempty path');
  if (values.records !== undefined && !values.records.trim()) throw new Error('--records requires a nonempty path');
  if (values.input !== undefined && !values.input.trim()) throw new Error('--input requires nonempty text');
  if (values.resume !== undefined && !values.resume.trim()) throw new Error('--resume requires a context identity');
  if (values.resume !== undefined && values.input !== undefined) throw new Error('Choose either --input or --resume');
  return Object.freeze({ mode: values.live ? 'live' : 'demo', database: resolve(values.db ?? (values.live ? '.capix/conversation.sqlite' : '.capix/conversation-demo.sqlite')), ...(values.records === undefined ? {} : { records: resolve(values.records) }), ...(values.input === undefined ? {} : { input: values.input }), ...(values.resume === undefined ? {} : { resume: values.resume }), help: values.help ?? false });
}
