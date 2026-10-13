// Open /test/copy.html through Vite. Clipboard is replaced locally; the system clipboard is untouched.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatMessages } from '../src/features/conversation/ChatMessages';
import { CopyMessageButton } from '../src/features/conversation/CopyMessageButton';
import type { ConversationItem } from '../src/state/conversation';
import '../src/styles.css';
import '../src/features/conversation/conversation.css';

const host = document.getElementById('root')!;
const root = createRoot(host);
const results: string[] = [];
const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
const written: string[] = [];
let write: (text: string) => Promise<void> = async (text) => {
  written.push(text);
};
Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => write(text) } });
const nothing = () => {};
async function settle() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
async function check(name: string, work: () => Promise<void>) {
  await work();
  results.push(`PASS ${name}`);
  document.getElementById('results')!.textContent = results.join('\n');
}
async function render(rows: ConversationItem[]) {
  root.render(
    <StrictMode>
      <div style={{ width: 500, height: 600, display: 'flex', flexDirection: 'column', margin: '20px auto' }}>
        <ChatMessages rows={rows} selectedId="" onInspect={nothing} onReconnect={async () => {}} onAbandon={async () => {}} />
      </div>
    </StrictMode>,
  );
  await settle();
}
function button(key: string) {
  const row = [...host.querySelectorAll<HTMLElement>('[data-conversation-key]')].find((element) => element.dataset.conversationKey === key);
  return row?.querySelector<HTMLButtonElement>('[aria-label="复制消息原文"]');
}
const user = '  **原样输入**\n\n第二行  ';
const answer = '**完整回答**\n\n- 保留 Markdown\n- 保留换行\n\n```ts\nconst source = 1;\n```\n\n' + '较长的正式回答。'.repeat(200);

try {
  await check('formal user and assistant messages each expose a keyboard accessible copy action', async () => {
    await render([{ kind: 'message', key: 'user', message: { role: 'user', content: user } }]);
    await render([
      { kind: 'message', key: 'user', message: { role: 'user', content: user } },
      { kind: 'message', key: 'assistant', message: { role: 'assistant', content: answer }, reveal: true },
    ]);
    const userButton = button('user');
    assert(userButton && button('assistant'), 'both formal roles can be copied');
    userButton.focus();
    assert(document.activeElement === userButton && userButton.type === 'button', 'native button accepts keyboard focus');
    userButton.click();
    await settle();
    assert(written.at(-1) === user, 'user whitespace and Markdown syntax preserved');
    assert(userButton.closest('.message-copy')!.textContent?.includes('已复制'), 'successful copy has local feedback');
  });
  await check('copying during playback uses the full original Markdown without presentation controls', async () => {
    assert(host.querySelector('.answer-reveal-all'), 'answer is still being revealed');
    button('assistant')!.click();
    await settle();
    assert(written.at(-1) === answer, 'full source copied independently of visible prefix');
    assert(!written.at(-1)!.includes('立即显示全文'), 'UI control text is excluded');
  });
  await check('pending input can be copied while an assistant without formal body has no copy action', async () => {
    await render([
      { kind: 'pending-input', key: 'pending', submissionId: 's', queueId: 'q', content: '尚未接纳的输入', label: '等待接纳' },
      { kind: 'response', key: 'response', submissionId: 's', queueId: 'q', afterInputKey: 'pending', bodyState: 'unconfirmed', process: { id: 's', label: '正在生成回答…', active: true } },
    ]);
    assert(button('pending'), 'pending input has its own text');
    assert(!button('response'), 'progress is not copyable message content');
    button('pending')!.click();
    await settle();
    assert(written.at(-1) === '尚未接纳的输入', 'pending input copied without status label');
  });
  await check('an assistant region copies only its formal body, excluding progress and notices', async () => {
    await render([{ kind: 'response', key: 'response', submissionId: 's', queueId: 'q', bodyState: 'available', body: { key: 'body', message: { role: 'assistant', content: '**正文**' } }, process: { id: 's', label: '正在整理记忆…', active: true }, notice: { message: '不可进入复制内容的提示', reconnect: false } }]);
    button('response')!.click();
    await settle();
    assert(written.at(-1) === '**正文**', 'response copies exact body source');
  });
  await check('clipboard rejection is local and allows another explicit attempt', async () => {
    write = async () => {
      throw new DOMException('denied', 'NotAllowedError');
    };
    button('response')!.click();
    await settle();
    assert(host.textContent?.includes('复制失败，请重试'), 'denial has visible feedback');
    assert(!button('response')!.disabled, 'failed clipboard operation does not disable retries');
    write = async (text) => {
      written.push(text);
    };
    button('response')!.click();
    await settle();
    assert(host.textContent?.includes('已复制') && !host.textContent.includes('复制失败'), 'successful retry replaces old failure');
  });
  await check('a missing Clipboard API is handled as a local copy failure', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    button('response')!.click();
    await settle();
    assert(host.textContent?.includes('复制失败，请重试'), 'unsupported environment does not throw out of the event handler');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text: string) => write(text) } });
  });
  await check('late clipboard completion cannot mark replacement content as copied', async () => {
    let finish: (() => void) | undefined;
    write = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    root.render(<CopyMessageButton content="旧内容" />);
    await settle();
    host.querySelector<HTMLButtonElement>('button')!.click();
    await settle();
    assert(host.querySelector<HTMLButtonElement>('button')!.disabled, 'pending copy prevents another click');
    root.render(<CopyMessageButton content="新内容" />);
    await settle();
    finish!();
    await settle();
    assert(!host.textContent?.includes('已复制'), 'old promise cannot publish success for another source');
    assert(!host.querySelector<HTMLButtonElement>('button')!.disabled, 'new content can be copied');
  });
  results.push(`ALL ${results.length} COPY BROWSER CHECKS PASSED`);
} catch (error) {
  results.push(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  root.unmount();
  if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
  else Reflect.deleteProperty(navigator, 'clipboard');
}
document.getElementById('results')!.textContent = results.join('\n');
