import { Badge } from '../../components/ui/badge';
import { MessageContent } from '../../components/message-content';
export const statusLabels: Record<string, string> = { running: '运行中', passed: '完成', succeeded: '完成', failed: '失败', unresolved: '上次运行未取得结束记录' };
export function Status({ value }: { value: string }) {
  return (
    <Badge variant="secondary" className={`status-tag status-${value}`}>
      {statusLabels[value] ?? value}
    </Badge>
  );
}
export function duration(value: number | undefined, status = 'running') {
  return value === undefined ? (status === 'running' ? '进行中' : '耗时未取得') : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(2)} s`;
}
export function DataBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="data-block">
      <h3>{title}</h3>
      <pre>{value === undefined ? '尚无记录' : JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}
export function TextBlock({ title, content, markdown = false }: { title: string; content: string; markdown?: boolean }) {
  return (
    <section className="text-block">
      <h3>{title}</h3>
      <div className="detail-message">
        <MessageContent content={content} format={markdown ? 'markdown' : 'plain'} />
      </div>
    </section>
  );
}
