import { ExceptionContract } from '@capix/invocation';

export type FileFailureReason = 'path' | 'unavailable' | 'workspace-unavailable' | 'outside' | 'symbolic-link' | 'not-file' | 'too-large' | 'encoding' | 'changed' | 'exists' | 'not-allowed' | 'io';

export const FileAccessException = new ExceptionContract<{ readonly operation: 'read' | 'create'; readonly path: string; readonly reason: FileFailureReason }>('FILE_ACCESS');

export function fileFailure(operation: 'read' | 'create', path: string, reason: FileFailureReason, cause?: unknown) {
  const messages: Record<FileFailureReason, string> = {
    path: '文件路径必须是工作目录内的规范相对路径。',
    unavailable: '文件或所在目录不可用。',
    'workspace-unavailable': '配置的文件工作目录不可用。',
    outside: '文件路径超出了配置的工作目录。',
    'symbolic-link': '文件访问不接受符号链接。',
    'not-file': '只能读取普通文本文件。',
    'too-large': '文件内容超过了本次能力允许的大小。',
    encoding: '文件内容必须是有效的 UTF-8 文本。',
    changed: '文件或目录在访问期间发生了变化。',
    exists: '输出文件已存在，未覆盖原文件。',
    'not-allowed': '该文件路径不在本次任务申请的范围内。',
    io: '文件操作未能完成。',
  };
  return FileAccessException.create(messages[reason], Object.freeze({ operation, path, reason }), cause === undefined ? undefined : { cause });
}
