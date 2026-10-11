import type { FileOutput, FileTask } from '@capix/protocol';

/** A publication receipt remains visible even when later work fails or is cancelled. */
export function FileResult({ task, output }: { task?: FileTask; output?: FileOutput }) {
  if (!task && !output) return null;
  const path = output?.status === 'created' ? output.receipt.path : (output?.path ?? task?.output?.path);
  const label = output?.status === 'created' ? '结果文件已创建' : output?.status === 'not-created' ? (output.reason === 'cancelled' ? '已取消文件创建' : output.reason === 'not-started' ? '未执行文件创建' : '结果文件未创建') : output?.status === 'pending' ? '等待创建结果文件' : output?.status === 'unconfirmed' ? '文件结果待确认' : path ? '计划保存到' : undefined;
  return (
    <div className="file-result" role="status" aria-live="polite">
      {task?.sourcePath && (
        <p>
          来源文件：<span>{task.sourcePath}</span>
        </p>
      )}
      {path && (
        <p>
          {label}：<span>{path}</span>
          {output?.status === 'created' && <span className="file-result-size"> · {output.receipt.bytes} 字节</span>}
        </p>
      )}
      {output?.status === 'unconfirmed' && <p>暂时无法确认是否已创建，请核对工作目录后再处理。</p>}
      {output?.status === 'not-created' && output.reason === 'failed' && <p>保存未完成。已有回答仍可查看或复制，请检查结果路径、已有文件和文件大小后再试。</p>}
    </div>
  );
}
