import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { TextReveal, type TextSource } from './reveal.js';

interface RevealScope {
  readonly players: Map<string, TextReveal>;
  readonly settled: Set<string>;
  readonly listeners: Set<() => void>;
  readonly subscribe: (listener: () => void) => () => void;
}

const Scope = createContext<RevealScope | undefined>(undefined);

/** A view-local cache: child remounts retain cursors; opening a view shows its history immediately. */
export function TextRevealProvider({ keys, children }: { keys: readonly string[]; children: ReactNode }) {
  const [scope] = useState<RevealScope>(() => {
    const listeners = new Set<() => void>();
    return {
      players: new Map(),
      settled: new Set(keys),
      listeners,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  });
  useEffect(() => {
    const current = new Set(keys);
    for (const key of scope.players.keys()) {
      if (!current.has(key)) scope.players.delete(key);
    }
    for (const key of scope.settled) {
      if (!current.has(key)) scope.settled.delete(key);
    }
  }, [keys, scope]);
  return <Scope.Provider value={scope}>{children}</Scope.Provider>;
}

const noSubscription = () => () => {};
const noPending = () => undefined;

/** Only completion wakes the conversation coordinator; individual text ticks stay local. */
export function usePendingTextReveal(keys: readonly string[]): string | undefined {
  const scope = useContext(Scope);
  const snapshot = useCallback(() => (scope ? keys.find((key) => !scope.settled.has(key)) : undefined), [keys, scope]);
  return useSyncExternalStore(scope?.subscribe ?? noSubscription, snapshot, noPending);
}

function complete(scope: RevealScope | undefined, key: string) {
  if (!scope) return;
  scope.settled.add(key);
  for (const listener of scope.listeners) listener();
}

interface Playback {
  readonly key: string;
  readonly player?: TextReveal;
  readonly snapshot?: TextReveal['snapshot'];
}

function begin(scope: RevealScope | undefined, key: string, source: TextSource, paced: boolean): Playback {
  const reduced = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!paced || reduced || scope?.settled.has(key)) {
    scope?.settled.add(key);
    return { key };
  }
  const player = scope?.players.get(key) ?? new TextReveal(source);
  scope?.players.set(key, player);
  return { key, player, snapshot: player.snapshot };
}

/** Receive updates only the available prefix. The browser clock advances the presentation cursor. */
export function useTextReveal(key: string, source: TextSource, paced: boolean) {
  const scope = useContext(Scope);
  const [playback, setPlayback] = useState(() => begin(scope, key, source, paced));
  const wake = useRef<(() => void) | undefined>(undefined);
  // A reused component may switch identity; never expose the previous body's cursor.
  if (playback.key !== key) setPlayback(begin(scope, key, source, paced));
  const player = playback.key === key ? playback.player : undefined;

  useEffect(() => {
    // Static and reduced-motion content also release a waiting assistant region.
    if (!player && source.complete) complete(scope, key);
  }, [key, player, scope, source.complete]);

  useEffect(() => {
    if (!player) return;
    let active = true;
    let frame: number | undefined;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const stop = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      player.pause();
    };
    const publish = () => {
      const snapshot = player.snapshot;
      if (snapshot.phase === 'finished') {
        complete(scope, key);
        if (scope?.players.get(key) === player) scope.players.delete(key);
        setPlayback((current) => (current.player === player ? { key } : current));
      } else setPlayback((current) => (current.player === player && current.snapshot !== snapshot ? { key, player, snapshot } : current));
    };
    const schedule = () => {
      if (!active) return;
      publish();
      if (document.hidden || player.snapshot.phase !== 'revealing') {
        stop();
        return;
      }
      if (frame !== undefined) return;
      frame = requestAnimationFrame((now) => {
        frame = undefined;
        if (!active) return;
        player.tick(now);
        schedule();
      });
    };
    const visibility = () => {
      stop();
      schedule();
    };
    const preference = () => {
      if (motion.matches) player.finish();
      schedule();
    };
    wake.current = schedule;
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', preference);
    preference();
    return () => {
      active = false;
      stop();
      if (wake.current === schedule) wake.current = undefined;
      document.removeEventListener('visibilitychange', visibility);
      motion.removeEventListener('change', preference);
    };
  }, [key, player, scope]);

  // Do not reset the clock on each input update: packet timing must not control playback.
  useEffect(() => {
    if (!player) return;
    player.receive({ text: source.text, complete: source.complete });
    if (!paced) player.finish();
    wake.current?.();
  }, [player, source.text, source.complete, paced]);

  return {
    // A presentation handoff is visible in this render; the effect retires the old clock.
    ...(player && paced ? playback.snapshot! : { text: source.text, phase: source.complete ? ('finished' as const) : ('waiting' as const) }),
    finish: () => {
      player?.finish();
      wake.current?.();
    },
  };
}
