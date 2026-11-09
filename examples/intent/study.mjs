// 固定的有/无材料对照，只有 --live 才会发送；每条结果立即写 JSONL。
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ChatCompletionsProvider } from '@weiliang0121/capix-model-provider';
import { catalog, decisionInstructions } from './catalog.mjs';
import { fixtures, studyPlan } from './fixtures.mjs';
import { runCase, summarize } from './experiment.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean', default: false }, out: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help || !values.live) {
  console.log('固定25次研究：node examples/intent/study.mjs --live --out /tmp/capix-intent-study.jsonl\n默认不请求；密钥由宿主提供 DEEPSEEK_API_KEY，目标文件不可已存在。');
} else {
  if (!values.out) throw new Error('--out is required to retain each paid request result');
  const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
  const model = new ChatCompletionsProvider({ endpoint: 'https://api.deepseek.com/chat/completions', apiKey: process.env.DEEPSEEK_API_KEY, model: modelName, thinking: 'disabled', timeoutMs: 45_000 });
  const file = await open(values.out, 'wx');
  const rows = [];
  try {
    await file.writeFile(`${JSON.stringify({ kind: 'study', createdAt: new Date().toISOString(), model: modelName, thinking: 'disabled', temperature: 0, maxTokens: 700, limit: studyPlan.length, promptSha256: createHash('sha256').update(decisionInstructions).digest('hex'), catalogSha256: createHash('sha256').update(JSON.stringify(catalog)).digest('hex'), plan: studyPlan })}\n`);
    for (const { id, condition } of studyPlan) {
      const fixture = fixtures.find((item) => item.id === id);
      const row = await runCase({ fixture, condition, model });
      rows.push(row);
      await file.writeFile(`${JSON.stringify({ kind: 'result', ...row })}\n`);
      console.log(`${rows.length}/${studyPlan.length} ${id}/${condition}: ${row.actual}${row.matched ? '' : `; expected ${row.expected}`}`);
      // Credentials, quota or endpoint errors are not semantic experiments; stop instead of spending the rest.
      if (row.status === 'provider-error') break;
    }
    await file.writeFile(`${JSON.stringify({ kind: 'summary', completed: rows.length === studyPlan.length, requests: rows.length, uniqueRequests: new Set(rows.map((row) => row.requestSha256)).size, conditions: summarize(rows) })}\n`);
  } finally {
    await file.close();
  }
}
