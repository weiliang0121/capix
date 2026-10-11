// Open /test/conversation.html through Vite. Uses actual layout and no service/model requests.
import { StrictMode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { ChatMessages } from '../src/features/conversation/ChatMessages';
import { Composer } from '../src/features/conversation/Composer';
import { MessageQueue } from '../src/features/conversation/MessageQueue';
import type { ConversationItem, ConversationResponse } from '../src/state/conversation';
import type { ConversationQueueView, SubmissionControl } from '../src/state/data';
import '../src/styles.css';
import '../src/features/conversation/conversation.css';

const host = document.getElementById('root')!;
const root = createRoot(host);
const results: string[] = [];
let sent = 0;
let cancelled = 0;
const nothing = () => {};
const send = async () => {
  sent++;
};
const cancel = async () => {
  cancelled++;
};
const emptyQueue = { waiting: [] };
interface Scene {
  rows: ConversationItem[];
  focus?: string;
  current?: SubmissionControl;
  draft?: string;
  queue?: ConversationQueueView;
  height?: number;
}
function View({ rows, focus, current, draft = '', queue = emptyQueue, height = 620 }: Scene) {
  return (
    <StrictMode>
      <div style={{ width: 550, height, display: 'flex', flexDirection: 'column', border: '1px solid #303030', margin: '20px auto', background: '#171717' }}>
        <ChatMessages rows={rows} focus={focus} selectedId="" onInspect={nothing} onReconnect={async () => {}} />
        <MessageQueue queue={queue} onCancel={cancel} />
        <Composer configured loaded draft={draft} current={current} onDraft={nothing} onSubmit={send} onCancel={cancel} />
      </div>
    </StrictMode>
  );
}
async function settle() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await new Promise((resolve) => setTimeout(resolve, 100));
}
async function render(scene: Scene) {
  root.render(<View {...scene} />);
  await settle();
}
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}
function near(actual: number, expected: number, label: string) {
  assert(Math.abs(actual - expected) < 4, `${label}: expected ${expected}, got ${actual}`);
}
function scroll() {
  return host.querySelector<HTMLElement>('.conversation-scroll')!;
}
function element(key: string) {
  return [...host.querySelectorAll<HTMLElement>('[data-conversation-key]')].find((row) => row.dataset.conversationKey === key)!;
}
function response(id: string, inputKey: string, body?: string): ConversationResponse {
  return { kind: 'response', key: `response-${id}`, submissionId: id, queueId: id, afterInputKey: inputKey, bodyState: body ? 'available' : 'unconfirmed', ...(body ? { body: { key: `body-${id}`, message: { role: 'assistant', content: body } } } : { process: { id, label: '正在生成回答…', active: true } }) };
}
const history: ConversationItem[] = Array.from({ length: 10 }, (_, index) => ({ kind: 'message', key: `history-${index}`, index, message: { role: index % 2 ? 'assistant' : 'user', content: index % 2 ? '历史回答。\n\n保留阅读位置，不被新的服务进展打断。' : '历史问题' } }));
const pending: ConversationItem = { kind: 'pending-input', key: 'pending-one', submissionId: 'one', queueId: 'one', content: '请介绍一下当前的处理过程', label: '等待接纳' };
const input: ConversationItem = { kind: 'message', key: 'input-one', index: 10, message: { role: 'user', content: pending.content } };
const control = { id: 'one', label: '停止当前回答', disabled: false };
let scene: Scene = { rows: history };
async function check(name: string, work: () => Promise<void>) {
  await work();
  results.push(`PASS ${name}`);
  document.getElementById('results')!.textContent = results.join('\n');
}

try {
  await check('history opens at the latest content', async () => {
    await render(scene);
    near(scroll().scrollTop, scroll().scrollHeight - scroll().clientHeight, 'history bottom');
  });
  let mounted: HTMLElement;
  await check('submission creates an assistant region and reserves the remaining viewport', async () => {
    scene = { rows: [...history, pending, response('one', pending.key)], focus: 'one', current: control };
    await render(scene);
    mounted = element('response-one');
    assert(mounted.textContent?.includes('助手') && mounted.textContent.includes('正在生成回答'), 'progress belongs to assistant');
    assert(parseFloat(mounted.style.minHeight) > 100, 'response reserve exists');
    near(element(pending.key).getBoundingClientRect().top - scroll().getBoundingClientRect().top, 20, 'input anchor');
    assert(!host.querySelector('.message-queue'), 'active request does not create an empty queue');
    assert(host.querySelector('[aria-label="停止当前回答"]'), 'stop replaces send');
    assert(!host.querySelector('[aria-label="发送消息"]'), 'no empty send beside stop');
  });
  await check('accepted input and completed body retain one assistant element without collapse', async () => {
    const oldTop = scroll().scrollTop;
    scene = { rows: [...history, input, response('one', input.key, '**回答**已经正式落实。')], focus: 'one' };
    await render(scene);
    assert(element('response-one') === mounted!, 'assistant element retained');
    assert(element('response-one').querySelector('strong')?.textContent === '回答', 'Markdown body merged');
    assert(!host.textContent?.includes('处理完成'), 'no redundant completed status');
    near(scroll().scrollTop, oldTop, 'short answer does not collapse');
    assert(host.querySelector('[aria-label="发送消息"]') && !host.querySelector('[aria-label="停止当前回答"]'), 'service terminal restores send');
  });
  await check('long content follows its actual rendered end', async () => {
    scene = { ...scene, rows: [...history, input, response('one', input.key, '回答正文。\n\n'.repeat(70))] };
    await render(scene);
    near(scroll().scrollTop, scroll().scrollHeight - scroll().clientHeight, 'long body bottom');
  });
  await check('manual downward scrolling to the bottom hides the latest button and resumes following', async () => {
    scroll().dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    scroll().scrollTop = 120;
    await settle();
    assert(host.querySelector('.conversation-latest'), 'reading shows latest button');
    scroll().scrollTop = 240;
    await settle();
    assert(host.querySelector('.conversation-latest'), 'partial downward scroll keeps reading');
    scroll().scrollTop = scroll().scrollHeight - scroll().clientHeight;
    await settle();
    assert(!host.querySelector('.conversation-latest'), 'manual bottom clears reading');
    scene = { ...scene, rows: [...history, input, response('one', input.key, '继续增长的回答正文。\n\n'.repeat(80))] };
    await render(scene);
    near(scroll().scrollTop, scroll().scrollHeight - scroll().clientHeight, 'growth follows after manual return');
  });
  await check('reading survives a new queued response, reserve transfer, and viewport resize', async () => {
    scroll().dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true }));
    scroll().scrollTop = 120;
    await settle();
    const anchor = element('history-2');
    const top = anchor.getBoundingClientRect().top - scroll().getBoundingClientRect().top;
    const next: ConversationItem = { kind: 'message', key: 'input-two', index: 12, message: { role: 'user', content: '自动派发的下一条' } };
    scene = { ...scene, rows: [...scene.rows, next, response('two', next.key)], current: { ...control, id: 'two' } };
    await render(scene);
    near(anchor.getBoundingClientRect().top - scroll().getBoundingClientRect().top, top, 'queue preserves reading anchor');
    assert(host.querySelector('.conversation-latest'), 'return-to-latest available');
    scene = { ...scene, height: 700, queue: { waiting: [{ id: 'three', pending: '真正等待的内容' }] } };
    await render(scene);
    near(anchor.getBoundingClientRect().top - scroll().getBoundingClientRect().top, top, 'queue/viewport resize preserves reading');
    assert(host.querySelector('.message-queue'), 'real queue visible');
  });
  await check('return to latest resumes following and completion retains reserved space', async () => {
    (host.querySelector('.conversation-latest') as HTMLButtonElement).click();
    await settle();
    near(scroll().scrollTop, scroll().scrollHeight - scroll().clientHeight, 'rejoined bottom');
    const reserved = element('response-two').style.minHeight;
    scene = { ...scene, rows: [...scene.rows.slice(0, -1), response('two', 'input-two', '短回答。')], current: undefined };
    await render(scene);
    assert(element('response-two').style.minHeight === reserved, 'completion keeps reserve');
    near(scroll().scrollTop, scroll().scrollHeight - scroll().clientHeight, 'short final bottom');
    scene = { ...scene, height: 590 };
    await render(scene);
    near(scroll().scrollTop, scroll().scrollHeight - scroll().clientHeight, 'rejoined viewport shrink follows');
  });
  await check('an explicit new send can rejoin while automatic queue work cannot', async () => {
    scroll().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    scroll().scrollTop = 0;
    await settle();
    const next: ConversationItem = { kind: 'pending-input', key: 'pending-four', submissionId: 'four', queueId: 'four', content: '主动发送', label: '等待接纳' };
    scene = { rows: [...scene.rows, next, response('four', next.key)], focus: 'four', current: { ...control, id: 'four' } };
    await render(scene);
    assert(!host.querySelector('.conversation-latest'), 'explicit send exits reading');
    near(element(next.key).getBoundingClientRect().top - scroll().getBoundingClientRect().top, 20, 'new input anchored');
  });
  await check('Enter never cancels; a draft uses the same send action during processing', async () => {
    const textarea = host.querySelector('textarea')!;
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    assert(cancelled === 0 && sent === 0, 'empty Enter does nothing');
    scene = { ...scene, draft: '继续发送即可' };
    await render(scene);
    assert(host.querySelector('[aria-label="发送消息"]') && host.querySelector('[aria-label="停止当前回答"]'), 'both actions available with a draft');
    host.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    assert(sent === 1 && cancelled === 0, 'Enter sends only');
    (host.querySelector('[aria-label="停止当前回答"]') as HTMLButtonElement).click();
    assert(cancelled === 1, 'separate stop targets current');
    assert(!host.textContent?.includes('加入队列'), 'no send mode choice');
  });
  await check('a late answer locator merges an already displayed body without moving the reading position', async () => {
    const lateInput: ConversationItem = { kind: 'message', key: 'input-late', message: { role: 'user', content: '先收到正文，后收到定位' } };
    const lateBody: ConversationItem = { kind: 'message', key: 'body-late', message: { role: 'assistant', content: '这段正式正文已经可以阅读。\n\n'.repeat(60) } };
    scene = { rows: [...history, lateInput, response('late', lateInput.key), lateBody], focus: 'late' };
    await render(scene);
    scroll().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    scroll().scrollTop -= 130;
    await settle();
    const before = host.querySelector('[data-message-key="body-late"]')!.getBoundingClientRect().top - scroll().getBoundingClientRect().top;
    scene = { ...scene, rows: [...history, lateInput, response('late', lateInput.key, lateBody.message.content)] };
    await render(scene);
    const bodies = host.querySelectorAll('[data-message-key="body-late"]');
    assert(bodies.length === 1, 'body is not duplicated');
    near(bodies[0]!.getBoundingClientRect().top - scroll().getBoundingClientRect().top, before, 'late locator reading anchor');
    assert(bodies[0]!.getAttribute('data-presentation') === 'finished', 'late locator never replays body');
  });
  await check('text playback respects reading intent and service completion stays independent', async () => {
    scene = { rows: history };
    await render(scene);
    const next: ConversationItem = { kind: 'message', key: 'input-paced', message: { role: 'user', content: '展示文字播放' } };
    const paced = response('paced', next.key, '逐字播放的回答。\n\n'.repeat(100));
    const animated: ConversationResponse = { ...paced, body: { ...paced.body!, reveal: true } };
    scene = { rows: [...history, next, animated], focus: 'paced' };
    await render(scene);
    assert(element('response-paced').querySelector('[data-presentation="revealing"]'), 'actual playback active');
    assert(!host.querySelector('[aria-label="停止当前回答"]'), 'completed service has no stop button');
    scroll().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    scroll().scrollTop = 100;
    await settle();
    const top = scroll().scrollTop;
    await new Promise((resolve) => setTimeout(resolve, 350));
    near(scroll().scrollTop, top, 'playback cannot reclaim scrolling');
    (host.querySelector('.answer-reveal-all') as HTMLButtonElement).click();
    await settle();
    near(scroll().scrollTop, top, 'show-all preserves reading too');
  });
  await check('automatic response handoff waits for visible playback while user input and current controls stay available', async () => {
    await render({ rows: history });
    const firstInput: ConversationItem = { kind: 'message', key: 'handoff-input', message: { role: 'user', content: '较长的上一条回答' } };
    const first = response('handoff', firstInput.key, '尚未播放完的正文。\n\n'.repeat(100));
    const animated: ConversationResponse = { ...first, body: { ...first.body!, reveal: true } };
    scene = { rows: [...history, firstInput, animated], focus: 'handoff' };
    await render(scene);
    const region = element(first.key);
    assert(region.querySelector('.answer-reveal-all'), 'old answer is playing');
    scroll().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    scroll().scrollTop = 100;
    await settle();
    const top = scroll().scrollTop;
    const nextInput: ConversationItem = { kind: 'pending-input', key: 'handoff-next-input', submissionId: 'handoff-next', queueId: 'handoff-next', content: '已经自动发送的下一条', label: '等待接纳' };
    scene = { ...scene, rows: [...scene.rows, nextInput, response('handoff-next', nextInput.key)], current: { ...control, id: 'handoff-next' } };
    flushSync(() => root.render(<View {...scene} />));
    assert(element(first.key) === region, 'handoff keeps the old response identity');
    assert(region.querySelector('.answer-reveal-all'), 'current playback is not interrupted');
    assert(!element('response-handoff-next'), 'next assistant waits for playback');
    assert(element(nextInput.key), 'already submitted input remains visible');
    assert(host.querySelector('[aria-label="停止当前回答"]'), 'control still targets actual current submission');
    await settle();
    near(scroll().scrollTop, top, 'automatic handoff preserves reading');
    (region.querySelector('.answer-reveal-all') as HTMLButtonElement).click();
    await settle();
    assert(!region.querySelector('.answer-reveal-all'), 'completed answer retires its skip control');
    assert(element('response-handoff-next').textContent?.includes('正在生成回答'), 'finishing playback opens the next assistant');
    near(scroll().scrollTop, top, 'delayed assistant does not reclaim reading');
    await render({ rows: [...history, firstInput, animated] });
    assert(!region.querySelector('.answer-reveal-all'), 'removing later region never replays the completed old answer');
  });
  await check('a late old body cannot close an already visible later assistant', async () => {
    await render({ rows: history });
    const firstInput: ConversationItem = { kind: 'message', key: 'late-old-input', message: { role: 'user', content: '旧正文稍后到达' } };
    const secondInput: ConversationItem = { kind: 'message', key: 'late-new-input', message: { role: 'user', content: '新一条' } };
    await render({ rows: [...history, firstInput, response('late-old', firstInput.key), secondInput, response('late-new', secondInput.key)] });
    const old = response('late-old', firstInput.key, '旧正文'.repeat(300));
    const next = response('late-new', secondInput.key, '新正文'.repeat(300));
    await render({ rows: [...history, firstInput, { ...old, body: { ...old.body!, reveal: true } }, secondInput, { ...next, body: { ...next.body!, reveal: true } }] });
    assert(element(old.key).querySelector('[data-presentation="finished"]'), 'late old body never starts playback');
    assert(element(next.key).querySelector('[data-presentation="revealing"]'), 'newest body can play');
    assert(host.querySelectorAll('.answer-reveal-all').length === 1, 'only one active answer player in the conversation');
  });
  await check('two completed answers received together are presented one at a time', async () => {
    await render({ rows: history });
    const first = response('batch-first', 'batch-user-first', '第一条'.repeat(300));
    const second = response('batch-second', 'batch-user-second', '第二条'.repeat(300));
    const rows: ConversationItem[] = [...history, { kind: 'message', key: 'batch-user-first', message: { role: 'user', content: '第一问' } }, { ...first, body: { ...first.body!, reveal: true } }, { kind: 'message', key: 'batch-user-second', message: { role: 'user', content: '第二问' } }, { ...second, body: { ...second.body!, reveal: true } }];
    await render({ rows, focus: 'batch-second' });
    assert(element(first.key).querySelector('[data-presentation="revealing"]'), 'first answer plays');
    assert(!element(second.key), 'second answer waits');
    assert(!host.querySelector('.conversation-latest'), 'explicit focus consumed while assistant hidden');
    scroll().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    scroll().scrollTop = 100;
    await settle();
    const top = scroll().scrollTop;
    (element(first.key).querySelector('.answer-reveal-all') as HTMLButtonElement).click();
    await settle();
    assert(element(first.key).querySelector('[data-presentation="finished"]'), 'first completes');
    assert(element(second.key).querySelector('[data-presentation="revealing"]'), 'second starts on presentation completion');
    assert(host.querySelector('.conversation-latest'), 'delayed assistant does not repeat old send focus');
    near(scroll().scrollTop, top, 'reading survives delayed focus target mounting');
  });
  await check('natural completion releases the next assistant without needing show-all', async () => {
    await render({ rows: history });
    const first = response('natural', 'natural-input', '自然结束的回答');
    await render({ rows: [...history, { ...first, body: { ...first.body!, reveal: true } }, response('natural-next', 'natural-next-input')] });
    const deadline = Date.now() + 2000;
    while (!element('response-natural-next') && Date.now() < deadline) await settle();
    assert(element('response-natural-next'), 'natural clock completion releases later region');
    assert(!element(first.key).querySelector('.answer-reveal-all'), 'first clock retired');
  });
  await check('empty and reduced-motion answers cannot strand a waiting assistant', async () => {
    await render({ rows: history });
    const empty: ConversationResponse = { ...response('empty', 'empty-input'), bodyState: 'available', body: { key: 'empty-body', message: { role: 'assistant', content: '' }, reveal: true } };
    await render({ rows: [...history, empty, response('after-empty', 'after-empty-input')] });
    assert(element('response-after-empty'), 'empty source releases next response');
    await render({ rows: history });
    const original = window.matchMedia;
    const reduced = Object.assign(new EventTarget(), { matches: true }) as MediaQueryList;
    window.matchMedia = (query) => (query === '(prefers-reduced-motion: reduce)' ? reduced : original.call(window, query));
    try {
      const first = response('reduced-first', 'reduced-first-input', '无需动画的正文'.repeat(100));
      const second = response('reduced-second', 'reduced-second-input', '下一条正文'.repeat(100));
      await render({ rows: [...history, { ...first, body: { ...first.body!, reveal: true } }, { ...second, body: { ...second.body!, reveal: true } }] });
      assert(element(first.key).querySelector('[data-presentation="finished"]'), 'reduced-motion first answer complete');
      assert(element(second.key).querySelector('[data-presentation="finished"]'), 'reduced-motion second answer is not blocked');
      assert(!host.querySelector('.answer-reveal-all'), 'no unnecessary animation controls');
    } finally {
      window.matchMedia = original;
    }
  });
  await check('content shrinking to the bottom does not take over a reader position', async () => {
    const next: ConversationItem = { kind: 'message', key: 'shrink-input', message: { role: 'user', content: '尺寸变化' } };
    scene = { rows: [...history, next, response('shrink', next.key, '长回答\n\n'.repeat(100))], focus: 'shrink' };
    await render(scene);
    scroll().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    scroll().scrollTop -= 100;
    await settle();
    scene = { ...scene, rows: [...history, next, response('shrink', next.key, '收缩后的内容')] };
    await render(scene);
    assert(host.querySelector('.conversation-latest'), 'layout clamp does not mean the reader requested latest');
  });
  await check('accepted input keeps a reading anchor when additional history precedes it', async () => {
    const pendingLong: ConversationItem = { kind: 'pending-input', key: 'pending-long', submissionId: 'long', queueId: 'long', content: '正在阅读的长问题。\n'.repeat(60), label: '等待接纳' };
    scene = { rows: [...history, pendingLong, response('long', pendingLong.key)], focus: 'long', current: { ...control, id: 'long' } };
    await render(scene);
    scroll().dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }));
    scroll().scrollTop += element(pendingLong.key).getBoundingClientRect().top - scroll().getBoundingClientRect().top + 180;
    await settle();
    const before = element(pendingLong.key).getBoundingClientRect().top - scroll().getBoundingClientRect().top;
    const formal: ConversationItem = { kind: 'message', key: 'formal-long', message: { role: 'user', content: pendingLong.content } };
    const appended: ConversationItem[] = [
      { kind: 'message', key: 'appended-user', message: { role: 'user', content: '本次提交附带的历史问题。' } },
      { kind: 'message', key: 'appended-assistant', message: { role: 'assistant', content: '本次提交附带的历史回答。' } },
    ];
    scene = { ...scene, rows: [...history, ...appended, formal, response('long', formal.key)] };
    await render(scene);
    near(element(formal.key).getBoundingClientRect().top - scroll().getBoundingClientRect().top, before, 'accepted input reading anchor');
  });
  results.push(`ALL ${results.length} CONVERSATION BROWSER CHECKS PASSED`);
} catch (error) {
  results.push(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
}
document.getElementById('results')!.textContent = results.join('\n');
