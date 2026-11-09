// 默认完全离线。真实模型：node examples/intent/run.mjs --live
import { open } from 'node:fs/promises';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { fixtures, conditions } from './fixtures.mjs';
import { runMatrix } from './experiment.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node examples/intent/run.mjs [--live] [--cases id,id] [--conditions input,history,memory,skills,full] [--limit 1..100] [--out new-file.json]
默认只用固定响应检查装配，不代表模型识别能力。
--live 使用 DEEPSEEK_API_KEY 和可选 DEEPSEEK_MODEL，默认前六例 × 五条件，最多 30 次请求。
--out 拒绝覆盖已有文件；省略时 JSON 写到 stdout，逐条进度写 stderr。
Cases: ${fixtures.map((fixture) => fixture.id).join(', ')}`);
  process.exit(0);
}
const options = { live: false, cases: null, conditions: Object.keys(conditions), limit: 30, out: null };
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--live') options.live = true;
  else if (argument === '--cases' || argument === '--conditions' || argument === '--limit' || argument === '--out') {
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new TypeError(`Missing value for ${argument}`);
    if (argument === '--cases') options.cases = value.split(',');
    if (argument === '--conditions') options.conditions = value.split(',');
    if (argument === '--limit') options.limit = Number(value);
    if (argument === '--out') options.out = value;
  } else throw new TypeError(`Unknown argument: ${argument}`);
}
if (options.cases?.some((id) => !fixtures.some((fixture) => fixture.id === id))) throw new TypeError('Unknown case id');
if (options.cases && new Set(options.cases).size !== options.cases.length) throw new TypeError('Duplicate case id');
if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new TypeError('Request limit must be 1..100');
if (!options.conditions.length || options.conditions.some((condition) => !Object.hasOwn(conditions, condition)) || new Set(options.conditions).size !== options.conditions.length) throw new TypeError('Invalid experiment conditions');
const selected = options.cases ? options.cases.map((id) => fixtures.find((fixture) => fixture.id === id)) : options.live ? fixtures.slice(0, 6) : [fixtures[0]];
let model;
if (options.live) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('Live mode requires DEEPSEEK_API_KEY');
  model = new ChatCompletionsProvider({ endpoint: 'https://api.deepseek.com/chat/completions', apiKey, model: process.env.DEEPSEEK_MODEL ?? 'deepseek-flash', thinking: 'disabled', timeoutMs: 45000 });
} else {
  // 只验证接线：固定返回同一决定，完全没有意图识别算法。
  model = { complete: async () => ({ id: 'offline-intent', formatVersion: 1, output: [{ kind: 'text', text: JSON.stringify({ kind: 'select', node: 'translate', reason: '离线固定响应，只验证装配。', evidence: [], question: null }) }], native: { format: 'chat-completions', version: 1 }, model: 'scripted-wiring-only', termination: { kind: 'completed', reason: 'stop' }, usage: null }) };
}
// Reserve the report before spending model requests; an existing path fails immediately.
const output = options.out ? await open(options.out, 'wx') : null;
try {
  const report = await runMatrix({
    fixtures: selected,
    selectedConditions: options.conditions,
    limit: options.limit,
    model,
    onResult: (row) => console.error(`${row.case} / ${row.condition}: ${row.actual}${row.matched ? '' : ` (expected ${row.expected})`}`),
  });
  const json = JSON.stringify({ mode: options.live ? 'live-model' : 'scripted-wiring-only', createdAt: new Date().toISOString(), note: options.live ? '固定合成样本的一次性对照，不代表普遍准确率。' : '固定响应只证明装配与结果接收；matched 不能解释为模型准确率。', ...report }, null, 2);
  if (output) await output.writeFile(`${json}\n`);
  else console.log(json);
} finally {
  await output?.close();
}
