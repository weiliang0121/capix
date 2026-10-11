import { LoaderCircle } from 'lucide-react';
import type { ConversationProcess as ProcessView } from '../../state/conversation.js';

/** One live hint per submission; previous stages remain in runtime facts, not in the message UI. */
export function ConversationProcess({ process }: { process: ProcessView }) {
  return (
    <div className="conversation-process" role="status" aria-live="polite" aria-atomic="true">
      <div className="conversation-process-summary">
        {process.active && <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />}
        <span>{process.label}</span>
      </div>
      {process.inputPending && <p className="conversation-process-notice">输入已接纳，消息正文待同步。</p>}
      {process.notice && <p className="conversation-process-notice">{process.notice}</p>}
    </div>
  );
}
