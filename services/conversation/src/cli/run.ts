import { createInterface, type Interface } from 'node:readline';
import { Runner } from '@capix/server-runtime';
import { loadConversationContent } from '../assembly/index.js';
import { createConversationHostAssembly } from '../hosting/assembly.js';
import { ConversationStore } from '../persistence/index.js';
import { createHostModel, hostModelName, hostRecoveryConfiguration } from '../hosting/model.js';
import { failureLabel } from '../hosting/diagnostic.js';
import { parseConversationOptions, usage } from './options.js';
import { RecordingFile } from './recording.js';
import { ToolStages } from '../hosting/tool-stages.js';

/** The executable owns I/O and lifetimes; Runner remains the sole owner of invocation activity. */
export async function runConversationCli(args: readonly string[]): Promise<number> {
  const options = parseConversationOptions(args);
  if (options.help) {
    console.log(usage);
    return 0;
  }
  // Validate credentials before opening a store or accepting any input.
  const model = createHostModel(options.mode);
  const configuration = hostRecoveryConfiguration(options.mode, hostModelName(options.mode), options.outputBudget, options.answerMode);
  const recording = options.records ? RecordingFile.open(options.records, options.database) : undefined;
  let openedStore: ConversationStore | undefined;
  let interactions: ReturnType<typeof createConversationHostAssembly>['interactions'] | undefined;
  let lines: Interface | undefined;
  let unsubscribe: (() => void) | undefined;
  let stages: ToolStages | undefined;
  let onInterrupt: (() => void) | undefined;
  let onTerminate: (() => void) | undefined;
  let onIoError: (() => void) | undefined;
  let exitCode = 0;
  try {
    const store = ConversationStore.open(options.database);
    openedStore = store;
    const content = loadConversationContent(store);
    const assembly = createConversationHostAssembly({ content, store, model, configuration, answerMode: options.answerMode, outputBudget: options.outputBudget });
    interactions = assembly.interactions;
    const installation = recording?.install(assembly.scene);
    const runner = new Runner(assembly.scene, assembly.resources, interactions, {
      ...(installation ? { observations: [installation] } : {}),
      checkpoints: { store: assembly.checkpoints },
      validate: assembly.assertAdmission,
    }).build();
    const entry = assembly.entry(runner);
    let closing = false;
    let ioFailed = false;
    let preview = false;
    if (assembly.toolLoop) {
      stages = new ToolStages(runner.observation, assembly.toolLoop);
      stages.subscribe({
        receive({ stage }) {
          if (!ioFailed && stage.status === 'running') console.log(`阶段：${stage.kind === 'model' ? '请求模型' : `执行工具 ${stage.label}`}`);
        },
      });
    }
    unsubscribe = runner.output.subscribe({
      receive(event) {
        if (ioFailed || event.kind !== 'delta') return;
        if (!preview) process.stdout.write('预览：');
        preview = true;
        process.stdout.write(event.delta);
      },
    });
    const closeInput = () => {
      closing = true;
      lines?.close();
    };
    onInterrupt = () => {
      if (runner.isRunning) {
        runner.cancel();
        if (!ioFailed) process.stderr.write('\n已请求停止本次调用；独立模型请求仍可完成。\n');
      } else closeInput();
    };
    onTerminate = () => {
      exitCode = 143;
      closeInput();
      runner.cancel();
    };
    onIoError = () => {
      ioFailed = true;
      if (exitCode === 0) exitCode = 1;
      closeInput();
      runner.cancel();
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    process.stdin.on('error', onIoError);
    process.stdout.on('error', onIoError);
    process.stderr.on('error', onIoError);
    const status = () => {
      if (!ioFailed) console.log(`状态：消息 ${content.transcript.length}，记忆 ${content.memories.values().length}，View 成员 ${content.view.members().length}`);
    };
    console.log(options.mode === 'demo' ? '离线演示：使用固定模型替身；不访问网络。记忆策略仅保存最近输入。' : '真实模型模式：每次回答后还会请求记忆提取；无自动重试。');
    if (options.answerMode === 'tools') console.log('工具回答：历史搜索与消息片段读取；展示阶段和最终回答，不展示候选正文。');
    status();
    const submit = async (line: string) => {
      if (!line.trim()) return;
      if (line.trim() === '/exit') return closeInput();
      if (line.trim() === '/status') return status();
      if (line.trim() === '/recoveries') {
        const candidates = assembly.listRecoveries();
        if (!ioFailed) console.log(candidates.length ? candidates.map((item) => `${item.contextId} · ${item.point} · ${'eligibility' in item && item.eligibility === 'unchecked' ? '候选：执行 /resume 时核验完整依据' : item.available ? '可以续接' : `不可续接：${item.reason}`}`).join('\n') : '没有未终结的 checkpoint。');
        return;
      }
      const command = /^\/resume(?:\s+(.+))?$/.exec(line.trim());
      preview = false;
      try {
        let result: string;
        if (command) {
          const contextId = command[1]?.trim();
          if (!contextId) throw new Error('/resume requires a context identity');
          if (!ioFailed) console.log(`续接：${contextId}（保留原调用身份，不重建历史记录）`);
          result = await entry.resume(contextId);
        } else result = await entry.run(line);
        if (!ioFailed && preview) process.stdout.write('\n');
        preview = false;
        // This is the actual returned result. A preview is never substituted for it.
        if (!ioFailed) console.log(`正式回答：${result}`);
      } catch (error) {
        if (!ioFailed && preview) process.stdout.write('\n');
        preview = false;
        if (!ioFailed) console.error(`本次未完成（${failureLabel(error)}）；已保存内容保留。`);
        if (exitCode === 0) exitCode = 1;
        // A poisoned store must not accept another submission. Ordinary model failures may.
        store.assertAvailable();
      }
    };
    if (options.resume !== undefined) {
      await submit(`/resume ${options.resume}`);
    } else if (options.input !== undefined) {
      await submit(options.input);
    } else {
      lines = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY) });
      lines.on('SIGINT', onInterrupt);
      lines.on('error', onIoError);
      const prompts = Boolean(process.stdin.isTTY);
      if (prompts) process.stdout.write('你：');
      // readline's iterator retains piped lines while the current submission is awaited.
      // EOF finishes the queued inputs; it does not cancel the running call.
      for await (const line of lines) {
        if (closing) break;
        await submit(line);
        if (closing) break;
        if (prompts) process.stdout.write('你：');
      }
    }
    closing = true;
  } finally {
    lines?.close();
    unsubscribe?.();
    stages?.close();
    // Shutdown does not reinterpret local cancellation as cancellation of the external sender.
    try {
      await interactions?.settled();
      interactions?.close();
    } finally {
      try {
        recording?.save();
      } finally {
        try {
          openedStore?.close();
        } finally {
          try {
            recording?.close();
          } finally {
            if (onInterrupt) process.off('SIGINT', onInterrupt);
            if (onTerminate) process.off('SIGTERM', onTerminate);
            if (onIoError) {
              process.stdin.off('error', onIoError);
              process.stdout.off('error', onIoError);
              process.stderr.off('error', onIoError);
            }
          }
        }
      }
    }
  }
  return exitCode;
}
