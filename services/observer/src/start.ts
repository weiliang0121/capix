import { isSafeInteger } from 'es-toolkit/compat';
import { ObserverConversations } from './assembly/conversations.js';
import { DeepSeekProvider } from './assembly/provider.js';
import { createObserverServer } from './http/server.js';
import { validateSettings } from './assembly/settings.js';
import { WorkspaceFiles } from './files/index.js';
import { SqliteObserverStore } from './persistence/store.js';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { existsSync, realpathSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const settings = validateSettings({
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  contextBudget: Number(process.env.CONTEXT_BUDGET || 32768),
  maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 1536),
  timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 90000),
});
const key = process.env.DEEPSEEK_API_KEY?.trim() || '';
const port = Number(process.env.PORT || 4317);
if (!isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const fileRoot = process.env.CAPIX_FILES_ROOT;
const files = fileRoot ? new WorkspaceFiles({ root: fileRoot }) : undefined;
const dataDirectory = resolve(process.env.CAPIX_DATA_DIR || fileURLToPath(new URL('../../../.capix/', import.meta.url)));
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
if (fileRoot) {
  const root = existsSync(fileRoot) ? realpathSync(fileRoot) : resolve(fileRoot);
  const location = relative(root, realpathSync(dataDirectory));
  const outside = location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location);
  if (!outside) throw new Error('内容数据库必须位于模型文件工作区之外。');
}
const persistence = SqliteObserverStore.open(resolve(dataDirectory, 'observer.sqlite'));
let conversations: ObserverConversations;
try {
  conversations = new ObserverConversations(() => new DeepSeekProvider(key), [], { files, persistence });
} catch (error) {
  persistence.close();
  throw error;
}
const server = createObserverServer({ conversations, settings, configured: Boolean(key) });
// Every change is already committed. An exiting active run leaves its archive open, never completed.
process.once('exit', () => {
  if (conversations.active) persistence.close();
  else conversations.close();
});
process.once('SIGINT', () => process.exit(0));
process.once('SIGTERM', () => process.exit(0));
server.listen(port, '127.0.0.1', () => console.log(`CAPiX Observer · http://127.0.0.1:${port} · DeepSeek ${key ? 'configured' : 'key missing'}`));
