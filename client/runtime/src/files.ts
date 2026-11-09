import type { FileTask, FileOutput } from '@weiliang0121/capix-protocol';
import { isEqual } from 'es-toolkit';
import { isPlainObject } from 'es-toolkit/predicate';

/** Validate the portable path contract only; confinement is enforced by the service. */
export function validFilePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 && !/[\\:\x00-\x1f\x7f]/u.test(path) && path.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..');
}

export function acceptFileTask(value: unknown): FileTask {
  if (!isPlainObject(value) || (value.sourcePath === undefined && value.output === undefined) || (value.sourcePath !== undefined && !validFilePath(value.sourcePath)) || Object.keys(value).some((key) => key !== 'sourcePath' && key !== 'output')) throw new Error('文件任务需要工作目录内的相对文件路径。');
  if (value.output !== undefined && (!isPlainObject(value.output) || !validFilePath(value.output.path) || Object.keys(value.output).some((key) => key !== 'path'))) throw new Error('结果文件需要工作目录内的相对路径。');
  if (value.sourcePath !== undefined && value.output?.path === value.sourcePath) throw new Error('结果文件需要不同于来源文件，不能覆盖来源。');
  const output = value.output ? Object.freeze({ path: value.output.path }) : undefined;
  return Object.freeze(value.sourcePath === undefined ? { output: output! } : { sourcePath: value.sourcePath, ...(output ? { output } : {}) });
}

/** A settled output fact cannot be changed by an overall failure or cancellation. */
export function acceptFileOutput(next: FileOutput | undefined, previous: FileOutput | undefined, task: FileTask | undefined): FileOutput | undefined {
  if (next === undefined) {
    if (previous) throw new Error('文件结果事实不能丢失。');
    return undefined;
  }
  if (!isPlainObject(next) || !['pending', 'created', 'not-created', 'unconfirmed'].includes(next.status)) throw new Error('文件结果状态无效。');
  const path = next.status === 'created' ? next.receipt?.path : next.path;
  if (!validFilePath(path) || path !== task?.output?.path) throw new Error('文件结果不属于本次申请的输出路径。');
  if (next.status === 'created' && (!isPlainObject(next.receipt) || !Number.isSafeInteger(next.receipt.bytes) || next.receipt.bytes < 0 || typeof next.receipt.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(next.receipt.digest))) throw new Error('文件落实凭据无效。');
  if (next.status === 'not-created' && !['not-started', 'cancelled', 'failed'].includes(next.reason)) throw new Error('文件未创建原因无效。');
  const accepted = Object.freeze(next.status === 'created' ? { status: next.status, receipt: Object.freeze({ path: next.receipt.path, bytes: next.receipt.bytes, digest: next.receipt.digest }) } : next.status === 'not-created' ? { status: next.status, path: next.path, reason: next.reason } : { status: next.status, path: next.path });
  if (previous && previous.status !== 'pending' && !isEqual(previous, accepted)) throw new Error('已确认的文件结果不能改变。');
  return accepted;
}
