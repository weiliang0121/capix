import { modelReplyText } from '@capix/model-provider';
// 显式真实模型小样本；不读取 .env、不重试、不改动 Observer 内容。
import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CompletionResource, ConversationMemoryResource, ConversationViewResource, createConversationScene, createMaterialAnswer, createMaterialPreparation, createMemoryMaintenance, createMessageInclusion } from '@capix/conversation-service';
import { Memories, MemoryResource } from '@capix/memory';
import { ChatCompletionsProvider, ProviderError } from '@capix/model-provider';
import { Resource } from '@capix/resources';
import { Resources, Runner } from '@capix/server-runtime';
import { Group } from '@capix/structure';
import { Transcript, TranscriptResource } from '@capix/transcript';
import { View } from '@capix/view';

const { values } = parseArgs({ options: { live: { type: 'boolean', default: false }, out: { type: 'string' }, 'after-first': { type: 'string' }, help: { type: 'boolean' } } });
if (values.help || !values.live) {
  console.log('Usage: node examples/conversation-memory-live.mjs --live --out new-report.jsonl [--after-first previous-report.jsonl]\n三次提交，最多五次真实请求，无自动重试；由宿主提供 DEEPSEEK_API_KEY 和可选 DEEPSEEK_MODEL。\n前两次回答后提取；第三次只检验记忆回答，不再次提取。报告拒绝覆盖文件。\n--after-first 从报告中成功的第一次提交加载内容样本，建立新 Runner，只跑后两次；不是恢复旧调用。');
} else {
  if (!values.out) throw new Error('--out is required before making paid requests');
  if (!process.env.DEEPSEEK_API_KEY?.trim()) throw new Error('Live mode requires DEEPSEEK_API_KEY');
  const file = openSync(values.out, 'wx', 0o600);
  try {
    await study((row) => writeFileSync(file, `${JSON.stringify(row)}\n`));
  } finally {
    closeSync(file);
  }
}

async function study(record) {
  const plan = ['请记住：我希望用简体中文回答，先用一句话给出结论，然后最多列三条要点。现在请只确认这项表达偏好。', '更正刚才的表达偏好：继续使用简体中文，但不要先给结论，也不要列点，改用两三句连贯短句。请只确认这次更正。', '我现在希望你用怎样的方式回答？请直接按这个方式回复。'];
  const seed = values['after-first'] ? firstSubmission(values['after-first'], plan[0]) : undefined;
  const startIndex = seed ? 1 : 0;
  const limit = seed ? 3 : 5;
  const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
  const provider = new ChatCompletionsProvider({ endpoint: 'https://api.deepseek.com/chat/completions', apiKey: process.env.DEEPSEEK_API_KEY, model: modelName, thinking: 'disabled', timeoutMs: 45_000 });
  const transcript = seed ? Transcript.restore(seed.transcript) : new Transcript();
  const memoryOptions = { changes: { capture: (event) => void current.memoryChanges.push(event) } };
  const memories = seed ? Memories.restore(seed.memories, transcript, memoryOptions) : new Memories(transcript, memoryOptions);
  const view = new View(seed?.view ?? { revision: 0, sources: { messages: { id: transcript.id, scope: 'whole' }, memories: { id: memories.id, scope: 'whole' } }, members: [] });
  let current;
  let requestCount = 0;
  let providerFailed = false;
  const model = {
    async complete(request, controls = {}) {
      if (requestCount >= limit) throw new Error('Study request limit reached');
      const number = ++requestCount;
      const started = performance.now();
      const input = JSON.parse(request.messages[1].content);
      const phase = request.stream ? 'answer' : 'memory';
      const measured = { number, phase, firstDeltaMs: null, deltaCount: 0, preview: '', input };
      current.requests.push(measured);
      record({ kind: 'request', submission: current.number, number, phase, request, input, formalMessages: transcript.length });
      try {
        const reply = await provider.complete(request, {
          signal: controls.signal,
          ...(request.stream
            ? {
                emit(delta) {
                  measured.firstDeltaMs ??= Math.round(performance.now() - started);
                  measured.deltaCount++;
                  measured.preview += delta;
                  controls.emit?.(delta);
                },
              }
            : {}),
        });
        measured.elapsedMs = Math.round(performance.now() - started);
        measured.reply = reply;
        record({ kind: 'reply', submission: current.number, ...measured });
        console.log(`提交 ${current.number} / ${phase}: ${measured.elapsedMs} ms, first delta ${measured.firstDeltaMs ?? '-'} ms, ${reply.termination.reason}`);
        return reply;
      } catch (error) {
        providerFailed = true;
        measured.elapsedMs = Math.round(performance.now() - started);
        measured.failure = failure(error);
        record({ kind: 'request-failed', submission: current.number, ...measured });
        throw error;
      }
    },
  };
  const maintain = new Group({ name: 'maintain-conversation-content' }).add({ include: createMessageInclusion(), remember: createMemoryMaintenance() });
  maintain.run = async (work) => {
    await work.children.include.invoke(work.input);
    // 本实验第三次只测已有记忆的消费；这是人工实验策略，不改变服务默认维护行为。
    if (current.number <= 2) await work.children.remember.invoke(work.input);
  };
  const material = new Resource({ transcript, memories, view });
  const memory = new Resource(memories);
  const resources = new Resources().register(new Resource(transcript), TranscriptResource.append).register(material, ConversationViewResource.read).register(material, ConversationViewResource.manage).register(memory, ConversationMemoryResource).register(memory, MemoryResource.apply).register(new Resource(model), CompletionResource);
  const runner = new Runner(createConversationScene(createMaterialAnswer(), createMaterialPreparation(), maintain), resources).build();
  const unsubscribeOutput = runner.output.subscribe({
    receive(event) {
      current.outputs.push({ elapsedMs: Math.round(performance.now() - current.started), formalMessages: transcript.length, ...event });
    },
  });
  const unsubscribeObservation = runner.observation.subscribe({
    receive(event) {
      if (event.source === 'invocation' && event.fact.kind === 'started') current.names.set(event.fact.identity.contextId, event.fact.description?.name);
      if (event.source === 'invocation' && event.fact.kind === 'relation') current.relations.push({ ...event.fact, childName: current.names.get(event.fact.relation.childContextId) });
    },
  });
  record({ kind: 'study', createdAt: new Date().toISOString(), model: modelName, limit, plan, startIndex, seedReport: values['after-first'], note: '人工小样本；实体仅在本进程内正式接纳，JSONL 是验证记录，不验证数据库持久化或重启恢复。可从第一轮成功快照建立新的测试实体和 Runner，不恢复旧调用。前两次回答后按默认策略读取完整前缀提取。第三次移出旧消息只为隔离记忆材料，保留原文，本实验不再提取；不改变服务默认维护策略。' });
  let completed = 0;
  let stopped = false;
  try {
    for (let index = startIndex; index < plan.length && !stopped; index++) {
      if (index === 2) {
        const excluded = view.members().filter((ref) => ref.source === 'messages');
        view.excludeSync(excluded);
        record({ kind: 'view-policy', beforeSubmission: 3, excluded, transcriptLength: transcript.length, members: view.members() });
      }
      current = { number: index + 1, started: performance.now(), requests: [], outputs: [], memoryChanges: [], relations: [], names: new Map() };
      const before = { memories: memories.exportState(), view: view.exportState(), transcript: transcript.exportState() };
      let result;
      let error;
      try {
        result = await runner.run(plan[index]);
      } catch (caught) {
        error = failure(caught);
        stopped = true;
      }
      const elapsedMs = Math.round(performance.now() - current.started);
      const answer = current.requests.find((item) => item.phase === 'answer');
      const preview = current.outputs
        .filter((event) => event.kind === 'delta')
        .map((event) => event.delta)
        .join('');
      const row = {
        kind: 'submission',
        number: current.number,
        input: plan[index],
        result,
        error,
        elapsedMs,
        before,
        after: { memories: memories.exportState(), view: view.exportState(), transcript: transcript.exportState() },
        memoryChanges: current.memoryChanges,
        relations: current.relations,
        outputs: current.outputs,
        checks: {
          runnerReleased: !runner.isRunning,
          previewMatchesProvider: answer?.reply ? preview === modelReplyText(answer.reply) : null,
          finalMatchesProvider: answer?.reply && !error ? result === modelReplyText(answer.reply) : null,
          finalMatchesFormalMessage: !error ? transcript.snapshot().at(-1)?.content === result : null,
          completedOutputs: current.outputs.filter((event) => event.kind === 'completed').length,
          messageMaterialCount: answer?.input.materials.entries.filter((entry) => entry.source === 'messages').length ?? null,
          memoryMaterialCount: answer?.input.materials.entries.filter((entry) => entry.source === 'memories').length ?? null,
          memoryProposalStatus: index === 2 ? 'not-requested' : current.relations.some((relation) => relation.childName === 'propose-conversation-memories' && relation.phase === 'handled') ? 'skipped' : current.relations.some((relation) => relation.childName === 'propose-conversation-memories' && relation.phase === 'accepted') ? 'accepted' : 'unknown',
        },
      };
      record(row);
      completed++;
      console.log(`提交 ${current.number}: ${error ? '失败' : '完成'}, ${elapsedMs} ms, 记忆 ${memories.values().length} 项 / sequence ${memories.sequence}`);
      // 服务可以接收提取故障；实验仍停止，避免配置或网络失败后继续付费。
      stopped ||= providerFailed;
    }
    record({ kind: 'summary', submissions: completed, requests: requestCount, complete: completed === plan.length - startIndex && !stopped, transcript: transcript.exportState(), memories: memories.exportState(), view: view.exportState() });
  } finally {
    unsubscribeOutput();
    unsubscribeObservation();
  }
}

function firstSubmission(path, input) {
  const rows = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const first = rows.find((row) => row.kind === 'submission' && row.number === 1);
  if (!first || first.error || first.input !== input || first.checks?.memoryProposalStatus !== 'accepted' || !first.after?.memories.items.length || first.after.transcript.messages.length !== 2 || first.after.transcript.messages[1].content !== first.result) throw new Error('Seed requires this study’s successful first submission with accepted memories');
  return first.after;
}

// ProviderError 是已消毒的公开诊断；其他异常不记录正文、cause 或请求头。
function failure(error) {
  if (error instanceof ProviderError) return { name: error.name, code: error.code, status: error.status, message: error.message };
  return { name: error instanceof Error ? error.name : typeof error, ...(typeof error?.code === 'string' ? { code: error.code } : {}) };
}
