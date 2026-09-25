import { isSafeInteger } from 'es-toolkit/compat';
import { initializeObserver } from './observer/environment.js';
import { DeepSeekProvider } from './provider.js';
import { createObserverServer } from './http/server.js';
import { validateSettings } from './settings.js';

const settings = validateSettings({
  model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
  contextBudget: Number(process.env.CONTEXT_BUDGET || 32768),
  maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 1536),
  timeoutMs: Number(process.env.MODEL_TIMEOUT_MS || 90000),
});
const key = process.env.DEEPSEEK_API_KEY?.trim() || '';
const port = Number(process.env.PORT || 4317);
if (!isSafeInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const server = createObserverServer({ observer: initializeObserver(new DeepSeekProvider(key)), settings, configured: Boolean(key) });
server.listen(port, '127.0.0.1', () => console.log(`CAPiX Observer · http://127.0.0.1:${port} · DeepSeek ${key ? 'configured' : 'key missing'}`));
