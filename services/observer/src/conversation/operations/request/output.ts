import { z } from 'zod';
import type { FileTask } from '@capix/protocol';
import { RuntimeError } from '@capix/server-runtime';
import { isRelativeFilePath } from '../../../files/index.js';
import { modelTextSchema } from '../../model/schema.js';
import type { ModelOutputContract } from '../../model/contract.js';

export type RequestProposal = { readonly kind: 'reply' } | { readonly kind: 'file'; readonly task: FileTask; readonly instruction: string } | { readonly kind: 'clarify'; readonly question: string } | { readonly kind: 'unsupported'; readonly explanation: string };

export interface RequestConstraints {
  readonly files: boolean;
  readonly fileTask?: FileTask;
}

const outputPathSchema = z.strictObject({ path: modelTextSchema.max(1024) });
const fileTaskSchema = z.union([z.strictObject({ sourcePath: modelTextSchema.max(1024), output: outputPathSchema.optional() }), z.strictObject({ output: outputPathSchema })]);
const requestProposalSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('reply') }), z.strictObject({ kind: z.literal('file'), task: fileTaskSchema, instruction: modelTextSchema }), z.strictObject({ kind: z.literal('clarify'), question: modelTextSchema }), z.strictObject({ kind: z.literal('unsupported'), explanation: modelTextSchema })]);

/** A model returns a proposal; choosing an executable task remains the parent's acceptance. */
export const requestOutputContract = {
  schema: z.toJSONSchema(requestProposalSchema),
  accept(value: unknown): RequestProposal {
    const parsed = requestProposalSchema.safeParse(value);
    if (!parsed.success) throw new RuntimeError('OUTPUT_SHAPE', '请求理解必须返回 reply、file、clarify 或 unsupported，且仅含对应契约字段。', { issues: parsed.error.issues });
    return parsed.data;
  },
} as const satisfies ModelOutputContract<unknown, RequestProposal>;

/** Check declared capability and exact explicit constraints before binding any file endpoint. */
export function acceptRequestProposal(proposal: RequestProposal, constraints: RequestConstraints): RequestProposal {
  const checked = requestOutputContract.accept(proposal);
  if (checked.kind === 'clarify') return Object.freeze(checked);
  if (checked.kind === 'file') {
    if (!constraints.files) return Object.freeze({ kind: 'unsupported', explanation: '当前服务未启用工作目录文件处理，无法执行本次文件操作。' });
    const task = checked.task;
    if ((task.sourcePath !== undefined && !isRelativeFilePath(task.sourcePath)) || (task.output !== undefined && !isRelativeFilePath(task.output.path))) return clarify('请提供工作目录内的相对文件路径，例如 notes.md；不能使用绝对路径或跨目录路径。');
    if (task.sourcePath !== undefined && task.output?.path === task.sourcePath) return clarify('结果只能保存为新文件，请提供不同于来源文件的保存路径。');
    if (constraints.fileTask && !matchesFileTask(task, constraints.fileTask)) return clarify('消息中的文件操作与填写的来源或保存路径不一致，请明确本次要读取和保存的文件。');
    const fixed: FileTask = task.sourcePath === undefined ? Object.freeze({ output: Object.freeze({ path: task.output.path }) }) : Object.freeze({ sourcePath: task.sourcePath, ...(task.output ? { output: Object.freeze({ path: task.output.path }) } : {}) });
    return Object.freeze({ kind: 'file', task: fixed, instruction: checked.instruction });
  }
  if (constraints.fileTask) return clarify('本次填写了文件任务，但请求内容尚未明确，请说明需要怎样处理该文件或生成保存的内容。');
  return Object.freeze(checked);
}

function matchesFileTask(task: FileTask, expected: FileTask): boolean {
  return task.sourcePath === expected.sourcePath && task.output?.path === expected.output?.path;
}

function clarify(question: string): RequestProposal {
  return Object.freeze({ kind: 'clarify', question });
}
