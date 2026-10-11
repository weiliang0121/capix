import { Button } from '../../components/ui/button.js';
import type { ConversationQueueView, SubmissionControl } from '../../state/data.js';

interface MessageQueueProps {
  queue: ConversationQueueView;
  current?: SubmissionControl;
  onCancel: (id: string) => Promise<void>;
  onCancelAll: () => Promise<void>;
  onClear: () => void;
  onPause: () => void;
  onResume: () => void;
}

/** Waiting input is local; it is separate from the server's formal transcript. */
export function MessageQueue({ queue, current, onCancel, onCancelAll, onClear, onPause, onResume }: MessageQueueProps) {
  if (!queue.waiting.length && !queue.paused && !queue.blocked && !current) return null;
  return (
    <section className="message-queue" aria-label="发送队列">
      <div className="message-queue-heading">
        <span>
          待发送 {queue.waiting.length}
          {queue.paused ? ' · 已暂停' : ''}
        </span>
        {current && (
          <Button type="button" variant="outline" size="sm" disabled={current.disabled} onClick={() => void onCancel(current.id)}>
            {current.label}
          </Button>
        )}
      </div>
      {queue.blocked && (
        <p className="message-queue-notice" role="status">
          {queue.blocked}
        </p>
      )}
      {queue.waiting.length > 0 && (
        <ol className="message-queue-list">
          {queue.waiting.map((item, index) => (
            <li key={item.id}>
              <span className="message-queue-index">{index + 1}</span>
              <p>{item.pending}</p>
              <Button type="button" variant="ghost" size="sm" onClick={() => void onCancel(item.id)} aria-label={`撤回待发送消息 ${index + 1}`}>
                撤回
              </Button>
            </li>
          ))}
        </ol>
      )}
      <div className="message-queue-actions">
        <Button type="button" variant="ghost" size="sm" onClick={queue.paused ? onResume : onPause}>
          {queue.paused ? '恢复队列' : '暂停队列'}
        </Button>
        {queue.waiting.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            清空待发送
          </Button>
        )}
        {(queue.waiting.length > 0 || current) && (
          <Button type="button" variant="ghost" size="sm" disabled={!queue.waiting.length && current?.disabled} onClick={() => void onCancelAll()}>
            取消全部
          </Button>
        )}
      </div>
    </section>
  );
}
