'use client';

// Chromeless route designed to be loaded inside an <iframe> on zeroindex.ai.
// Broadcasts content height to the parent window via postMessage so the host
// can size the iframe to fit content; the host wraps the iframe in a
// max-height: 640px overflow-y: auto container that handles overflow scroll.

import { useEffect, useRef } from 'react';
import { AskWidget } from '@/components/AskWidget';

const RESIZE_MSG = 'ask-zeroindex/resize';
// Pin postMessage target origin in production to prevent unrelated parents
// from receiving height events. Empty / unset = "*" (dev default).
const PARENT_ORIGIN = process.env.NEXT_PUBLIC_PARENT_ORIGIN || '*';

export default function Embed() {
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.parent === window) return; // not in an iframe — no-op

    // overflow: hidden on html/body kills the iframe's internal scrollbar so
    // it can't flicker during the lag between content growth and iframe resize.
    document.documentElement.classList.add('no-overflow');

    const main = mainRef.current;
    if (!main) return;

    let lastH = -1;
    let rafId: number | null = null;

    // Coalesce ResizeObserver fires (text-delta streams trigger many per frame)
    // and dedupe by height — parent only hears about real changes.
    const post = () => {
      rafId = null;
      const h = Math.ceil(main.getBoundingClientRect().height);
      if (h === lastH) return;
      lastH = h;
      window.parent.postMessage({ type: RESIZE_MSG, height: h }, PARENT_ORIGIN);
    };

    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(post);
    };

    schedule();
    const observer = new ResizeObserver(schedule);
    observer.observe(main);
    return () => {
      observer.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.documentElement.classList.remove('no-overflow');
    };
  }, []);

  return (
    <main ref={mainRef} className="ask-surface p-8 md:p-10">
      {/* Bare widget only — the heading + intro live in the zeroindex.ai #ask
          section (the marketing HTML), since the iframe renders inside that site. */}
      <AskWidget showFooterCredits={false} />
    </main>
  );
}
