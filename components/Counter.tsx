'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Counts a numeric value up when scrolled into view. Non-numeric parts of the
 * string (prefixes, +, %, ×) are preserved so "99.9%" and "60+" both work.
 */
export default function Counter({ value, duration = 1400 }: { value: string; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(value);
  const match = value.match(/^([^\d]*)([\d.,]+)(.*)$/);

  useEffect(() => {
    if (!match) return;
    const el = ref.current;
    if (!el) return;

    const [, prefix, rawNumber, suffix] = match;
    const target = parseFloat(rawNumber.replace(/,/g, ''));
    const decimals = (rawNumber.split('.')[1] ?? '').length;
    const grouped = rawNumber.includes(',');

    if (!Number.isFinite(target)) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;

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
      const p = Math.min((ts - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(`${prefix}${format(target * eased)}${suffix}`);
      if (p < 1) raf = requestAnimationFrame(step);
    };

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          // Zeroed here rather than up front, so a value that is never
          // scrolled into view still renders its real number.
          setDisplay(`${prefix}${format(0)}${suffix}`);
          raf = requestAnimationFrame(step);
          io.disconnect();
        }
      },
      { threshold: 0.4 },
    );

    io.observe(el);

    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, duration, match]);

  return (
    <span ref={ref} suppressHydrationWarning>
      {display}
    </span>
  );
}
