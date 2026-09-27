import { useRef } from 'react';
import { ArrowUp, LoaderCircle } from 'lucide-react';
import { Textarea } from '../../components/ui/textarea';
import { Button } from '../../components/ui/button';
export function Composer({ configured, loaded, busy, draft, onDraft, onSubmit }: { configured: boolean; loaded: boolean; busy: boolean; draft: string; onDraft: (text: string) => void; onSubmit: () => Promise<void> }) {
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
        disabled={busy}
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
        <span>{!configured && loaded ? '请在服务端配置模型 Key' : 'Enter 发送 · Shift + Enter 换行'}</span>
        <Button type="submit" size="icon" disabled={busy || !configured || !draft.trim()} aria-label={busy ? '运行中' : '发送消息'}>
          {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
        </Button>
      </div>
    </form>
  );
}
