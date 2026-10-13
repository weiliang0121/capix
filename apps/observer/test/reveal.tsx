// Open /test/reveal.html in the app's Vite dev server. No service or model is used.
import { StrictMode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { TextRevealProvider, useTextReveal } from '../src/presentation/text/react';
import type { TextSource } from '../src/presentation/text/reveal';
import { AnswerContent } from '../src/features/conversation/AnswerContent';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
const originalFrame = window.requestAnimationFrame;
const originalCancel = window.cancelAnimationFrame;
const originalMedia = window.matchMedia;
const originalVisibility = Object.getOwnPropertyDescriptor(document, 'hidden');
let hidden = false;
let reduced = false;
const media = new EventTarget();
window.requestAnimationFrame = (callback) => {
  const id = ++frameId;
  frames.set(id, callback);
  return id;
};
window.cancelAnimationFrame = (id) => frames.delete(id);
Object.defineProperty(media, 'matches', { get: () => reduced, configurable: true });
window.matchMedia = () => media as MediaQueryList;
Object.defineProperty(document, 'hidden', { get: () => hidden, configurable: true });

const host = document.getElementById('root')!;
const root = createRoot(host);
const results: string[] = [];
type Entry = TextSource & { id: string; instance?: string; paced?: boolean; mounted?: boolean };
function Probe({ entry }: { entry: Entry }) {
  const view = useTextReveal(entry.id, entry, entry.paced ?? true);
  return (
    <section data-id={entry.id} data-phase={view.phase}>
      <output>{view.text}</output>
      <button onClick={view.finish}>全文</button>
    </section>
  );
}
function Scene({ entries, scope = 'one' }: { entries: Entry[]; scope?: string }) {
  return (
    <StrictMode>
      <TextRevealProvider key={scope} keys={entries.map((entry) => entry.id)}>
        {entries
          .filter((entry) => entry.mounted !== false)
          .map((entry) => (
            <Probe key={entry.instance ?? entry.id} entry={entry} />
          ))}
      </TextRevealProvider>
    </StrictMode>
  );
}
async function render(entries: Entry[], scope = 'one') {
  await act(async () => root.render(<Scene entries={entries} scope={scope} />));
}
async function tick(time: number) {
  await act(async () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(time);
  });
}
function text(id: string) {
  return host.querySelector(`[data-id="${id}"] output`)?.textContent;
}
function equal(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
async function check(name: string, work: () => Promise<void>) {
  await work();
  results.push(`PASS ${name}`);
}

try {
  await check('initial history is static, even if an old eligibility flag remains', async () => {
    await render([{ id: 'history', text: '历史全文', complete: true }]);
    equal(text('history'), '历史全文', 'history');
    equal(frames.size, 0, 'history clock');
  });
  const first = { id: 'first', text: '甲'.repeat(800), complete: true };
  const second = { id: 'second', text: '乙'.repeat(200), complete: true };
  await check('StrictMode starts one clock per answer; two answers advance independently', async () => {
    await render([first]);
    equal(text('first'), '', 'initial cursor');
    equal(frames.size, 1, 'single clock');
    await tick(0);
    await tick(100);
    equal(text('first')?.length, 10, 'first rate');
    await render([first, second]);
    equal(frames.size, 2, 'two clocks');
    await tick(200);
    await tick(300);
    equal(text('first')?.length, 30, 'first continues');
    equal(text('second')?.length, 4, 'independent second rate');
  });
  await check('child remount retains its cursor and does not accrue hidden time', async () => {
    await render([{ ...first, mounted: false }, second]);
    equal(frames.size, 1, 'unmounted clock removed');
    await render([{ ...first, instance: 'replacement' }, second]);
    equal(text('first')?.length, 30, 'retained cursor');
    await tick(10000);
    equal(text('first')?.length, 30, 'no remount catchup');
    await tick(10100);
    equal(text('first')?.length, 40, 'resumed');
  });
  await check('show all retires its clock; remount and reopening history never replay it', async () => {
    await act(async () => (host.querySelector('[data-id="first"] button') as HTMLButtonElement).click());
    equal(text('first'), first.text, 'show all');
    await render([{ ...first, instance: 'again' }, second]);
    equal(text('first'), first.text, 'completed remount');
    await render([first, second], 'reopened');
    equal(text('second'), second.text, 'reopened history');
    equal(frames.size, 0, 'history clocks stopped');
  });
  await check('receive updates preserve clock fractions; open sources wait and resume without debt', async () => {
    await render([], 'stream');
    await render([{ id: 'stream', text: 'a', complete: false }], 'stream');
    await tick(0);
    await tick(10);
    await render([{ id: 'stream', text: 'abcd', complete: false }], 'stream');
    await tick(25);
    equal(text('stream'), 'a', 'input did not reset fractional progress');
    await tick(100);
    equal(text('stream'), 'abcd', 'caught up');
    equal(frames.size, 0, 'waiting has no clock');
    await render([{ id: 'stream', text: 'abcdef', complete: false }], 'stream');
    await tick(20000);
    equal(text('stream'), 'abcd', 'no waiting debt');
    await tick(20025);
    equal(text('stream'), 'abcde', 'normal resumed rate');
  });
  await check('visibility and reduced-motion control presentation without changing content', async () => {
    await render([{ id: 'stream', text: 'abcdef'.repeat(20), complete: true }], 'stream');
    const before = text('stream');
    await act(async () => {
      hidden = true;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    equal(frames.size, 0, 'background clock');
    await act(async () => {
      hidden = false;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await tick(50000);
    equal(text('stream'), before, 'no background catchup');
    await act(async () => {
      reduced = true;
      media.dispatchEvent(new Event('change'));
    });
    equal(text('stream'), 'abcdef'.repeat(20), 'motion preference');
    equal(frames.size, 0, 'reduced motion clock');
    await render([{ id: 'reduced', text: '立即显示', complete: true }], 'stream');
    equal(text('reduced'), '立即显示', 'new reduced-motion answer');
    reduced = false;
  });
  await check('reused component identity cannot expose a previous cursor', async () => {
    await render([], 'identity');
    await render([{ id: 'old', instance: 'fixed-component', text: '旧'.repeat(40), complete: true }], 'identity');
    await tick(0);
    await tick(100);
    equal(text('old'), '旧'.repeat(4), 'old cursor');
    await render([{ id: 'new', instance: 'fixed-component', text: '新'.repeat(40), complete: true }], 'identity');
    equal(text('new'), '', 'new cursor');
    equal(frames.size, 1, 'old clock released');
  });
  await check('actual answer component renders incomplete Markdown and exposes skip control', async () => {
    await act(async () =>
      root.render(
        <TextRevealProvider keys={[]}>
          <div />
        </TextRevealProvider>,
      ),
    );
    await act(async () =>
      root.render(
        <TextRevealProvider keys={['answer']}>
          <AnswerContent id="answer" content={'**重点**\n\n' + '内容'.repeat(40)} reveal />
        </TextRevealProvider>,
      ),
    );
    await tick(0);
    await tick(100);
    equal(host.querySelector('.answer-content')?.getAttribute('data-presentation'), 'revealing', 'presentation state');
    equal(host.querySelector('.answer-content [aria-live="off"]')?.getAttribute('aria-busy'), 'true', 'no per-character announcement');
    await act(async () => (host.querySelector('.answer-reveal-all') as HTMLButtonElement).click());
    equal(host.querySelector('strong')?.textContent, '重点', 'final Markdown');
    equal(host.querySelector('.answer-reveal-all'), null, 'skip removed');
    equal(frames.size, 0, 'answer clock retired');
  });
  await check('initial active sources remain waiting even without animation and support plain rendering', async () => {
    await act(async () =>
      root.render(
        <TextRevealProvider key="pending-source" keys={['partial']} pendingKeys={['partial']}>
          <AnswerContent id="partial" content="**纯文本**" complete={false} reveal={false} format="plain" />
        </TextRevealProvider>,
      ),
    );
    equal(host.querySelector('.answer-content')?.getAttribute('data-presentation'), 'waiting', 'static partial source remains incomplete');
    equal(host.querySelector('.message-text')?.textContent, '**纯文本**', 'plain content is not Markdown');
    equal(host.querySelector('strong'), null, 'no accidental Markdown parsing');
    equal(host.querySelector('.answer-reveal-all'), null, 'waiting has no show-all control');
    await act(async () =>
      root.render(
        <TextRevealProvider key="pending-source" keys={['partial']}>
          <AnswerContent id="partial" content="**纯文本** 完成" complete reveal={false} format="plain" />
        </TextRevealProvider>,
      ),
    );
    equal(host.querySelector('.answer-content')?.getAttribute('data-presentation'), 'finished', 'formal completion finishes static source');
  });
  results.push(`ALL ${results.length} BROWSER CHECKS PASSED`);
} catch (error) {
  results.push(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
} finally {
  await act(async () => root.unmount());
  window.requestAnimationFrame = originalFrame;
  window.cancelAnimationFrame = originalCancel;
  window.matchMedia = originalMedia;
  if (originalVisibility) Object.defineProperty(document, 'hidden', originalVisibility);
  else Reflect.deleteProperty(document, 'hidden');
  document.getElementById('results')!.textContent = results.join('\n');
}
