import { performance } from 'node:perf_hooks';
import { createHarness } from './assembly.mjs';
import { finalReply, toolReply } from './fixtures.mjs';

const historyBytes = Number(process.argv[2] ?? 2048);
if (!Number.isSafeInteger(historyBytes) || historyBytes < 0 || historyBytes > 256 * 1024) throw new Error('Usage: run.mjs [fixed-material-bytes: 0..262144]');
const modelCalls = process.argv[3] === undefined ? undefined : Number(process.argv[3]);
const toolResultBytes = Number(process.argv[4] ?? 5);
if ((modelCalls !== undefined && (!Number.isSafeInteger(modelCalls) || modelCalls < 1 || modelCalls > 8)) || !Number.isSafeInteger(toolResultBytes) || toolResultBytes < 0 || toolResultBytes > 256 * 1024) throw new Error('Usage: run.mjs [material-bytes] [model-calls: 1..8] [tool-result-bytes: 0..262144]');
const harness = createHarness({
  retainSnapshots: false,
  ...(modelCalls === undefined
    ? {}
    : {
        toolSource: { files: new Map([['notes.md', 'x'.repeat(toolResultBytes)]]), reads: 0, writes: 0 },
        model(request) {
          const step = request.messages.filter((message) => message.role === 'assistant').length;
          return step + 1 < modelCalls ? toolReply([{ id: 'read', name: 'read_text', arguments: '{"path":"notes.md"}' }], { id: `model-${step}` }) : finalReply('Complete.', `model-${step}`);
        },
      }),
});
const startCpu = process.cpuUsage();
const start = performance.now();
try {
  const result = await harness.runner.run(harness.input('x'.repeat(historyBytes)));
  const cpu = process.cpuUsage(startCpu);
  const elapsedMs = performance.now() - start;
  console.log(JSON.stringify({ result, historyBytes, toolResultBytes, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, models: harness.requests.length, tools: { reads: harness.files.reads, writes: harness.files.writes }, checkpoint: harness.checkpoints.report(), interaction: harness.persistence.report() }, null, 2));
} finally {
  await harness.close();
}
