import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { Runner } from '@capix/server-runtime';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent, createConversationHostAssembly } from '@capix/conversation-service/assembly';
import { ToolStages } from '@capix/conversation-service/tools/hosting';
import { studyModel } from './model.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, out: { type: 'string' }, case: { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('node examples/tool-host-study/run.mjs --out NEW_DIRECTORY [--live] [--case NAME]\n默认离线容量测量；--live 显式执行思考/非思考及错误/取消/局部超时历史工具对话。不读.env，不覆盖旧目录，不记录凭证、不自动重试。');
} else {
  if (!values.out) throw new Error('--out requires a new directory');
  if (values.live && !process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('Live study requires DEEPSEEK_API_KEY');
  const output = resolve(values.out);
  await mkdir(output, { recursive: false });
  const plans = values.live
    ? [
        { name: 'live-nonthinking', thinking: 'disabled', questions: ['请搜索历史中包含“青松”的消息，读取最早匹配消息原文，再回答该项目上线日期；附消息索引。', '请分别检索“青松”和“赤岩”项目的原文，对比预算，附消息索引。', '请检索历史中的“紫鲸”项目；没有记录就明确说没有，不要猜。'] },
        { name: 'live-thinking', thinking: 'enabled', questions: ['请搜索“赤岩”的历史，读取原文后给出预算和验收日期，附消息索引。', '请分别搜索“青松”和“赤岩”原始消息，比较两个项目的预算差额，附消息索引。'] },
        { name: 'live-invalid', thinking: 'disabled', questions: ['请实际调用 read_message 读取索引99999999的消息。若工具拒绝，就如实报告拒绝原因，不要搜索其他消息或猜测正文。'] },
        { name: 'live-cancel', thinking: 'disabled', cancelAfterDispatch: true, questions: ['搜索“青松”的历史，回答上线日期。'] },
        { name: 'live-local-timeout', thinking: 'disabled', waitMs: 1, questions: ['搜索“青松”的历史，回答上线日期。'] },
      ]
    : [
        { name: 'one-model', thinking: 'disabled', modelCalls: 1, toolSlots: 1, materialBytes: 256 },
        { name: 'four-models', thinking: 'disabled', modelCalls: 4, toolSlots: 4, materialBytes: 32 * 1024 },
        { name: 'eight-models-32-slots', thinking: 'disabled', modelCalls: 8, toolSlots: 32, materialBytes: 248 * 1024 },
      ];
  const selected = values.case ? plans.filter((plan) => plan.name === values.case || (values.case === 'edges' && ['live-invalid', 'live-cancel', 'live-local-timeout'].includes(plan.name))) : plans;
  if (!selected.length) throw new Error('Unknown study case');
  const results = [];
  for (const plan of selected) {
    console.log(`开始：${plan.name}`);
    const metrics = { requests: [], wireBytes: 0, checkpoints: [], stages: [], turns: [] };
    const dispatched = Promise.withResolvers();
    const model = studyModel({ ...plan, live: !!values.live, metrics, onDispatch: () => dispatched.resolve() });
    const path = join(output, `${plan.name}.sqlite`);
    const store = ConversationStore.open(path);
    let assembly;
    let stages;
    try {
      const content = loadConversationContent(store);
      content.transcript.append({ role: 'user', content: values.live ? '青松项目：预算48万元，上线日期2026年12月18日。负责人林岚。' : 'history material '.repeat(1000) }, { role: 'assistant', content: '已记录青松项目。' }, { role: 'user', content: '赤岩项目：预算31万元，验收日期2027年1月12日。负责人周远。' }, { role: 'assistant', content: '已记录赤岩项目。' });
      assembly = createConversationHostAssembly({ content, store, model: model.provider, answerMode: 'tools', configuration: JSON.stringify({ study: 'tool-host-v1', model: model.name, thinking: plan.thinking }), ...(plan.waitMs ? { toolPolicy: { modelWaitMs: plan.waitMs } } : {}) });
      const checkpoints = {
        read: (id) => assembly.checkpoints.read(id),
        save(image, revision) {
          const started = performance.now();
          const result = assembly.checkpoints.save(image, revision);
          const elapsedMs = performance.now() - started;
          metrics.checkpoints.push({ operation: 'save', point: image.point, contract: image.contract.key, children: image.frame.children.length, bytes: Buffer.byteLength(JSON.stringify(image)), elapsedMs });
          return result;
        },
        finish(contextId, revision, delivery) {
          const started = performance.now();
          const result = assembly.checkpoints.finish(contextId, revision, delivery);
          metrics.checkpoints.push({ operation: 'finish', bytes: Buffer.byteLength(JSON.stringify(delivery)), elapsedMs: performance.now() - started });
          return result;
        },
      };
      const runner = new Runner(assembly.scene, assembly.resources, assembly.interactions, { checkpoints: { store: checkpoints }, validate: assembly.assertAdmission }).build();
      const entry = assembly.entry(runner);
      stages = new ToolStages(runner.observation, assembly.toolLoop);
      stages.subscribe({
        receive: (event) => {
          metrics.stages.push(event.stage);
        },
      });
      const questions = plan.questions ?? [`请处理：${'x'.repeat(plan.materialBytes)}`];
      for (const input of questions) {
        const started = performance.now();
        const cpuStarted = process.cpuUsage();
        try {
          const running = entry.run(input);
          if (plan.cancelAfterDispatch) {
            await Promise.race([dispatched.promise, running]);
            runner.cancel();
          }
          const answer = await running;
          metrics.turns.push({ status: 'completed', elapsedMs: performance.now() - started, inputBytes: Buffer.byteLength(input), ...(values.live ? { input, answer } : { answerCharacters: answer.length }), loadedAfterExit: assembly.exchanges.loadedCount });
        } catch (error) {
          metrics.turns.push({ status: plan.cancelAfterDispatch ? 'cancelled' : 'failed', elapsedMs: performance.now() - started, inputBytes: Buffer.byteLength(input), error: error?.code ?? error?.name ?? 'unknown', loadedAfterExit: assembly.exchanges.loadedCount, pendingAfterExit: assembly.interactions.pendingCount });
        }
        const cpu = process.cpuUsage(cpuStarted);
        metrics.turns.at(-1).cpuMs = (cpu.user + cpu.system) / 1000;
        console.log(`完成：${plan.name} · ${metrics.turns.length}/${questions.length} · ${metrics.turns.at(-1).status}`);
      }
      await assembly.interactions.settled();
      const saves = metrics.checkpoints.filter((item) => item.operation === 'save');
      const usage = store.archiveUsage();
      const result = { plan, live: !!values.live, model: model.name, archiveUsage: usage, archives: store.exchanges.list().items, summary: { saveCount: saves.length, finishCount: metrics.checkpoints.length - saves.length, largestImageBytes: Math.max(0, ...saves.map((row) => row.bytes)), maxDirectChildren: Math.max(0, ...saves.map((row) => row.children)), totalCheckpointWriteBytes: metrics.checkpoints.reduce((sum, row) => sum + row.bytes, 0), totalCheckpointSyncMs: metrics.checkpoints.reduce((sum, row) => sum + row.elapsedMs, 0), maxCheckpointSyncMs: Math.max(0, ...metrics.checkpoints.map((row) => row.elapsedMs)), preparedAndWaiting: saves.filter((row) => row.contract === 'conversation.tools.archived-answer' && (row.point === 'prepared' || row.point === 'waiting')), headroomBytes: assembly.archivePolicy.headroomBytes, withinConfiguredHeadroom: usage.totalBytes < assembly.archivePolicy.headroomBytes }, metrics };
      result.diskBeforeClose = {
        database: (await stat(path)).size,
        wal: await stat(`${path}-wal`).then(
          (value) => value.size,
          () => 0,
        ),
      };
      // The host holds an exclusive SQLite writer lock. Inspect durable facts
      // only after its independent senders have settled and the store is closed.
      stages.close();
      assembly.interactions.close();
      store.close();
      const reader = new DatabaseSync(path, { readOnly: true });
      let durableFeedbackCount;
      try {
        durableFeedbackCount = reader.prepare("SELECT COUNT(*) AS count FROM completion_interactions WHERE json_type(body, '$.feedback') = 'object'").get().count;
        result.checkpointRetention = {
          ...reader.prepare('SELECT COUNT(*) AS imageIdentities, COUNT(body) AS retainedBodies, COUNT(*) - COUNT(body) AS discardedBodies FROM checkpoint_images').get(),
          heads: reader.prepare('SELECT COUNT(*) AS count FROM checkpoint_heads').get().count,
        };
      } finally {
        reader.close();
      }
      result.durableFeedbackCount = durableFeedbackCount;
      await writeFile(join(output, `${plan.name}.json`), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      results.push({ name: plan.name, summary: result.summary, archiveUsage: usage, checkpointRetention: result.checkpointRetention, turns: metrics.turns, requests: metrics.requests.length, wireBytes: metrics.wireBytes, durableFeedbackCount, passed: plan.cancelAfterDispatch ? metrics.turns.every((turn) => turn.status === 'cancelled' && turn.pendingAfterExit > 0 && turn.loadedAfterExit === 0) && durableFeedbackCount === 1 : plan.waitMs ? metrics.turns.every((turn) => turn.status === 'failed' && turn.error === 'ModelReplyPending' && turn.loadedAfterExit === 0) && durableFeedbackCount === 1 : metrics.turns.every((turn) => turn.status === 'completed') });
    } finally {
      stages?.close();
      await assembly?.interactions.settled();
      assembly?.interactions.close();
      store.close();
    }
  }
  await writeFile(join(output, 'summary.json'), `${JSON.stringify({ version: 1, results, note: 'Offline bytes/timing measure this host and synthetic workload; not a maximum guarantee. Archive usage and checkpointRetention describe retained data; totalCheckpointWriteBytes sums successful save/finish payloads and excludes SQLite/WAL overhead. cpuMs is process CPU during each run, not checkpoint-only CPU. Live cases test compatibility, not general tool-selection accuracy. No automatic retry.' }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`报告：${join(output, 'summary.json')}`);
  if (results.some((item) => !item.passed)) process.exitCode = 1;
}
