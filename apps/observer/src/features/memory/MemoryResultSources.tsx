import type { MemoryResultSource } from '@weiliang0121/capix-protocol';

export function MemoryResultSources({ sources, label = '操作依据' }: { sources?: readonly MemoryResultSource[]; label?: string }) {
  if (!sources?.length) return null;
  return (
    <details className="memory-result-sources">
      <summary>
        {label} · {sources.length} 条
      </summary>
      <p>以下凭据表示当时已创建文件，不保证文件现在仍存在或内容未变。</p>
      {sources.map((source) => (
        <blockquote key={source.id}>
          <span>已创建文件 · 关联回答 [{source.answerIndex}]</span>
          <div>
            {source.receipt.path} · {source.receipt.bytes} 字节
          </div>
          <div className="memory-result-digest">内容摘要（SHA-256）：{source.receipt.digest}</div>
        </blockquote>
      ))}
    </details>
  );
}
