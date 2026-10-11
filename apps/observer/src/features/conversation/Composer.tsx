import { useRef } from 'react';
import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import { Textarea } from '../../components/ui/textarea.js';
import { Button } from '../../components/ui/button.js';
import type { SubmissionControl } from '../../state/data.js';

interface ComposerProps {
  configured: boolean;
  loaded: boolean;
  draft: string;
  current?: SubmissionControl;
  onDraft: (text: string) => void;
  onSubmit: () => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}

export function Composer({ configured, loaded, draft, current, onDraft, onSubmit, onCancel }: ComposerProps) {
  const composing = useRef(false);
  const hasDraft = Boolean(draft.trim());
  const send = () => {
    if (configured && hasDraft) void onSubmit();
  };
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Textarea
        aria-label="输入消息"
        value={draft}
        onChange={(event) => onDraft(event.target.value)}
        placeholder="输入消息，继续这段对话…"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !composing.current) {
            event.preventDefault();
            send();
          }
        }}
      />
      <div className="composer-bottom">
        <span>{!configured && loaded ? '请在服务端配置模型 Key' : 'Enter 发送 · Shift + Enter 换行'}</span>
        <div className="flex items-center gap-2">
          {current && (
            <Button type="button" variant={hasDraft ? 'outline' : 'default'} size="icon" disabled={current.disabled} aria-label={current.label} onClick={() => void onCancel(current.id)}>
              {current.disabled ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <Square aria-hidden="true" fill="currentColor" />}
            </Button>
          )}
          {(hasDraft || !current) && (
            <Button type="submit" size="icon" disabled={!configured || !hasDraft} aria-label="发送消息">
              <ArrowUp aria-hidden="true" />
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}
