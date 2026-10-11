import type { ConfigurationResponse } from '@capix/protocol';
import { useRef } from 'react';
import { ArrowUp, LoaderCircle, Square } from 'lucide-react';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Button } from '../../components/ui/button.js';
import type { SubmissionControl } from '../../state/data.js';

interface ComposerProps {
  configured: boolean;
  loaded: boolean;
  draft: string;
  current?: SubmissionControl;
  files?: ConfigurationResponse['files'];
  fileDraft?: { sourcePath: string; outputPath: string };
  onFileDraft?: (draft: { sourcePath: string; outputPath: string }) => void;
  onDraft: (text: string) => void;
  onSubmit: () => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}

export function Composer({ configured, loaded, draft, current, files, fileDraft, onFileDraft, onDraft, onSubmit, onCancel }: ComposerProps) {
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
      {files && fileDraft && onFileDraft && (
        <details className="file-task-controls">
          <summary>指定工作目录文件{fileDraft.sourcePath || fileDraft.outputPath ? ' · 已填写' : ''}</summary>
          <p>可在消息中说明要读取或保存的相对路径，也可在此明确指定本次文件任务。读取 UTF-8 文本最多 {Math.floor(files.maxReadBytes / 1024)} KiB，内容在执行时读取。</p>
          <label>
            来源文件（可选）
            <Input value={fileDraft.sourcePath} onChange={(event) => onFileDraft({ ...fileDraft, sourcePath: event.target.value })} placeholder="notes.md" aria-label="来源文件相对路径" />
          </label>
          <label>
            保存结果（可选）
            <Input value={fileDraft.outputPath} onChange={(event) => onFileDraft({ ...fileDraft, outputPath: event.target.value })} placeholder="summary.md" aria-label="结果文件相对路径" />
          </label>
          <p>仅填写保存路径即可生成新文件，最多 {Math.floor(files.maxWriteBytes / 1024)} KiB；不覆盖已有文件。填写的路径仅用于本次请求。</p>
        </details>
      )}
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
