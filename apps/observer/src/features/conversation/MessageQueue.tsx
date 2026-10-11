import { Button } from '../../components/ui/button.js';
import type { ConversationQueueView } from '../../state/data.js';

interface MessageQueueProps {
  queue: ConversationQueueView;
  onCancel: (id: string) => Promise<void>;
}

/** Waiting input is local; it is separate from the server's formal transcript. */
export function MessageQueue({ queue, onCancel }: MessageQueueProps) {
  if (!queue.waiting.length) return null;
  return (
    <section className="message-queue" aria-label="发送队列">
      <div className="message-queue-heading">待发送 {queue.waiting.length}</div>
      {queue.blocked && (
        <p className="message-queue-notice" role="status">
          {queue.blocked}
        </p>
      )}
      <ol className="message-queue-list">
        {queue.waiting.map((item, index) => (
          <li key={item.id}>
            <span className="message-queue-index">{index + 1}</span>
            <div className="message-queue-content">
              <p>{item.pending}</p>
              {item.fileTask && (
                <span className="message-queue-file">
                  {item.fileTask.sourcePath ? `文件：${item.fileTask.sourcePath}` : '保存结果'}
                  {item.fileTask.output ? `${item.fileTask.sourcePath ? ' → ' : '：'}${item.fileTask.output.path}` : ''}
                </span>
              )}
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => void onCancel(item.id)} aria-label={`撤回待发送消息 ${index + 1}`}>
              撤回
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
