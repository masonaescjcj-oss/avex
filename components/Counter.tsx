'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Counts a numeric value up when scrolled into view. Non-numeric parts of the
 * string (prefixes, +, %, ×) are preserved so "99.9%" and "60+" both work.
 */
export default function Counter({ value, duration = 1400 }: { value: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(value);
  // Guards against a second run: each frame of the count re-renders this
  // component, and the animation must not restart when it does.
  const ran = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || ran.current) return;

    // Parsed inside the effect: a match array created during render would be a
    // new object every frame, re-running this effect and restarting the count.
    const match = value.match(/^([^\d]*)([\d.,]+)(.*)$/);
    if (!match) return;

    const [, prefix, rawNumber, suffix] = match;
    const target = parseFloat(rawNumber.replace(/,/g, ''));
    if (!Number.isFinite(target)) return;

    const decimals = (rawNumber.split('.')[1] ?? '').length;
    const grouped = rawNumber.includes(',');

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const format = (n: number) => {
      const fixed = n.toFixed(decimals);
      return grouped
        ? Number(fixed).toLocaleString('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          })
        : fixed;
    };

    let raf = 0;
    let start = 0;

    const step = (ts: number) => {
      if (!start) start = ts;
      const progress = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(`${prefix}${format(target * eased)}${suffix}`);
      if (progress < 1) raf = requestAnimationFrame(step);
      else setDisplay(value); // land exactly on the written value
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || ran.current) return;
        ran.current = true;
        io.disconnect();
        // Zeroed here rather than up front, so a value that is never scrolled
        // into view still renders its real number.
        setDisplay(`${prefix}${format(0)}${suffix}`);
        raf = requestAnimationFrame(step);
      },
      { threshold: 0.4 },
    );

    io.observe(el);

    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, duration]);

  return (
    <span ref={ref} suppressHydrationWarning>
      {display}
    </span>
  );
}
