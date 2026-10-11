import { useRef } from 'react';
import { ArrowUp } from 'lucide-react';
import { Textarea } from '../../components/ui/textarea.js';
import { Button } from '../../components/ui/button.js';
export function Composer({ configured, loaded, queueing, draft, onDraft, onSubmit }: { configured: boolean; loaded: boolean; queueing: boolean; draft: string; onDraft: (text: string) => void; onSubmit: () => Promise<void> }) {
  const composing = useRef(false);
  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
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
            void onSubmit();
          }
        }}
      />
      <div className="composer-bottom">
        <span>{!configured && loaded ? '请在服务端配置模型 Key' : `Enter ${queueing ? '加入队列' : '发送'} · Shift + Enter 换行`}</span>
        <Button type="submit" size="icon" disabled={!configured || !draft.trim()} aria-label={queueing ? '加入队列' : '发送消息'}>
          <ArrowUp />
        </Button>
      </div>
    </form>
  );
}
