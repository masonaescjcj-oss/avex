'use client';

import { useEffect, useRef, useState } from 'react';

/** True once the element has entered the viewport; never flips back. */
export function useInView<T extends HTMLElement>(threshold = 0.3) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || inView) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setInView(true);
          io.disconnect();
        }
      },
      { threshold },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [threshold, inView]);

  return [ref, inView] as const;
}

/** Tracks the OS reduced-motion preference, including later changes to it. */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setReduced(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  return reduced;
}

/**
 * Advances 0 → total once `active`, one step per `interval`.
 * Jumps straight to the finished state when `instant` is set.
 */
export function useSteps(active: boolean, total: number, interval = 560, instant = false) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!active) return;
    if (instant) {
      setStep(total);
      return;
    }
    if (step >= total) return;

    const id = window.setTimeout(() => setStep((s) => s + 1), step === 0 ? 300 : interval);
    return () => window.clearTimeout(id);
  }, [active, step, total, interval, instant]);

  return step;
}

/**
 * How far the element has travelled through the viewport, 0 → 1.
 * Scrubs both ways, so scrolling back up rewinds whatever it drives.
 */
export function useScrollProgress<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let raf = 0;

    const measure = () => {
      const rect = el.getBoundingClientRect();
      const vh = window.innerHeight;
      // Starts when the top reaches 88% of the viewport, completes when the
      // bottom passes 45% of it.
      const from = vh * 0.88;
      const to = vh * 0.45;
      const span = rect.height + from - to;
      if (span <= 0) return;
      setProgress(Math.min(1, Math.max(0, (from - rect.top) / span)));
    };

    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);

    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return [ref, progress] as const;
}
