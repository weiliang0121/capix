import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useStickToBottom, type GetTargetScrollTop } from 'use-stick-to-bottom';

interface ResponsePosition {
  readonly key: string;
  readonly inputKey?: string;
}
interface ReadingAnchor {
  readonly key: string;
  readonly offset: number;
  readonly body?: { readonly key: string; readonly offset: number };
}

/** Reading intent belongs to the view, independently of service completion and text playback. */
export function useConversationScroll(rows: unknown, response: ResponsePosition | undefined, focus?: string) {
  const detached = useRef(false);
  const [reading, setReading] = useState(false);
  const position = useRef(response);
  position.current = response;
  const anchor = useRef<ReadingAnchor | undefined>(undefined);
  const reserved = useRef<HTMLElement | undefined>(undefined);
  const consumedFocus = useRef(focus);
  const measure = useRef<(() => void) | undefined>(undefined);
  // The library retains its initial target callback. Read live intent through the ref.
  const target = useCallback<GetTargetScrollTop>((bottom, { scrollElement }) => (detached.current ? scrollElement.scrollTop : bottom), []);
  const stick = useStickToBottom({ initial: 'instant', resize: 'instant', targetScrollTop: target });
  const { scrollRef, contentRef, state, scrollToBottom, stopScroll } = stick;

  const remember = useCallback(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    const top = scroll.getBoundingClientRect().top;
    const row = [...content.querySelectorAll<HTMLElement>('[data-conversation-key]')].find((element) => element.getBoundingClientRect().bottom > top + 1);
    const body = row?.querySelector<HTMLElement>('[data-message-key]');
    anchor.current = row ? { key: row.dataset.conversationKey!, offset: row.getBoundingClientRect().top - top, ...(body ? { body: { key: body.dataset.messageKey!, offset: body.getBoundingClientRect().top - top } } : {}) } : undefined;
  }, [contentRef, scrollRef]);

  const leave = useCallback(() => {
    detached.current = true;
    setReading(true);
    stopScroll();
    remember();
  }, [remember, stopScroll]);

  const latest = useCallback(() => {
    detached.current = false;
    setReading(false);
    measure.current?.();
    // Direct positioning also handles a smaller target after reserved space was released.
    state.scrollTop = Math.max(0, state.targetScrollTop);
    void scrollToBottom('instant');
    remember();
  }, [remember, scrollToBottom, state]);

  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!scroll || !content) return;
    let frame: number | undefined;
    let active = true;
    let previousHeight = scroll.clientHeight;
    let previousTop = scroll.scrollTop;
    let previousPosition = position.current;
    let touchY: number | undefined;
    const update = () => {
      const elements = [...content.querySelectorAll<HTMLElement>('[data-conversation-key]')];
      const current = position.current;
      const element = current ? elements.find((row) => row.dataset.conversationKey === current.key) : undefined;
      const input = current?.inputKey ? elements.find((row) => row.dataset.conversationKey === current.inputKey) : undefined;
      let geometryChanged = previousHeight !== scroll.clientHeight;
      previousHeight = scroll.clientHeight;
      if (reserved.current !== element) {
        reserved.current?.style.removeProperty('min-height');
        reserved.current = element;
        geometryChanged = true;
      }
      // Only a response at the end can reserve space. Unassociated formal content
      // arriving ahead of its locator stays visible without an empty block before it.
      const atEnd = element === elements.at(-1);
      const padding = getComputedStyle(content);
      const inset = parseFloat(padding.paddingTop) + parseFloat(padding.paddingBottom);
      const gap = input && element ? element.getBoundingClientRect().top - input.getBoundingClientRect().top : 0;
      const height = element && atEnd ? Math.max(0, scroll.clientHeight - gap - inset) : 0;
      const minimum = height ? `${height}px` : '';
      if (element && element.style.minHeight !== minimum) {
        element.style.minHeight = minimum;
        geometryChanged = true;
      }
      if (detached.current) {
        stopScroll();
        const saved = anchor.current;
        const inputReplaced = saved && current?.key === previousPosition?.key && saved.key === previousPosition?.inputKey;
        const key = inputReplaced ? current?.inputKey : saved?.key;
        const row = saved && elements.find((candidate) => candidate.dataset.conversationKey === key);
        if (row) state.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.offset;
        else if (saved?.body) {
          // A formal answer can move into its response when the locator arrives later.
          const body = [...content.querySelectorAll<HTMLElement>('[data-message-key]')].find((candidate) => candidate.dataset.messageKey === saved.body!.key);
          if (body) state.scrollTop += body.getBoundingClientRect().top - scroll.getBoundingClientRect().top - saved.body.offset;
        }
      } else if (geometryChanged && state.isAtBottom) {
        state.scrollTop = Math.max(0, state.targetScrollTop);
        void scrollToBottom({ animation: 'instant', preserveScrollPosition: true });
      }
      previousPosition = current;
      previousTop = scroll.scrollTop;
      remember();
    };
    const schedule = () => {
      if (!active || frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        if (active) update();
      });
    };
    const scrolled = () => {
      const top = scroll.scrollTop;
      if (top < previousTop - 1 && top !== state.ignoreScrollToTop && !state.resizeDifference) leave();
      // Reading uses the current position as the library target. Only real
      // downward movement to the physical bottom can restore following here;
      // resize/anchor adjustments must not silently replace reading intent.
      if (detached.current && top > previousTop && !state.resizeDifference && scroll.scrollHeight - scroll.clientHeight - top <= 2) latest();
      previousTop = top;
      remember();
    };
    const wheel = (event: WheelEvent) => {
      if (event.deltaY < 0) leave();
    };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) leave();
    };
    const touched = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const moved = (event: TouchEvent) => {
      const next = event.touches[0]?.clientY;
      if (next !== undefined && touchY !== undefined && next > touchY) leave();
      touchY = next;
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(scroll);
    observer.observe(content);
    scroll.addEventListener('scroll', scrolled, { passive: true });
    scroll.addEventListener('wheel', wheel, { passive: true });
    scroll.addEventListener('keydown', key);
    scroll.addEventListener('touchstart', touched, { passive: true });
    scroll.addEventListener('touchmove', moved, { passive: true });
    measure.current = update;
    update();
    return () => {
      active = false;
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
      scroll.removeEventListener('scroll', scrolled);
      scroll.removeEventListener('wheel', wheel);
      scroll.removeEventListener('keydown', key);
      scroll.removeEventListener('touchstart', touched);
      scroll.removeEventListener('touchmove', moved);
      if (measure.current === update) measure.current = undefined;
    };
  }, [contentRef, latest, leave, remember, scrollRef, scrollToBottom, state, stopScroll]);

  useLayoutEffect(() => {
    measure.current?.();
    // Explicit input takes focus as soon as it is visible. Assistant presentation
    // may wait for an earlier answer, and must not replay this focus when it mounts.
    const focusExists = focus && [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-submission-input], [data-response-id]') ?? [])].some((element) => element.dataset.submissionInput === focus || element.dataset.responseId === focus);
    if (focus && focus !== consumedFocus.current && focusExists) {
      consumedFocus.current = focus;
      latest();
    }
  }, [rows, response?.key, response?.inputKey, focus, latest, contentRef]);

  // Preserve selection-induced escapes even when a later shrink makes the library relock.
  useLayoutEffect(() => {
    if (stick.escapedFromLock && !detached.current) leave();
  }, [stick.escapedFromLock, leave]);

  return { scrollRef, contentRef, reading, latest };
}
