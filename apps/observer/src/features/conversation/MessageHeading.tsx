import { ArrowUpRight } from 'lucide-react';
import type { ConversationMessage } from '../../state/conversation';
import { CopyMessageButton } from './CopyMessageButton';

export function MessageHeading({ label, message, copyContent, onInspect }: { label: string; message?: ConversationMessage; copyContent?: string; onInspect: (id: string) => void }) {
  const content = message?.message.content ?? copyContent;
  return (
    <div className="message-heading">
      <span>
        {label} {message?.index !== undefined && <span className="message-index">[{message.index}]</span>}
      </span>
      <div className="message-actions">
        {content !== undefined && <CopyMessageButton content={content} />}
        {message?.executionId && (
          <button type="button" className="message-location" onClick={() => onInspect(message.executionId!)} aria-label={`查看第 ${message.round} 轮问答`}>
            问答 {String(message.round).padStart(2, '0')}
            <ArrowUpRight size={12} />
          </button>
        )}
      </div>
    </div>
  );
}
