'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './Terminal.module.css';

type Props = {
  cmd: string;
  lines: string[];
  status: string;
  label?: string;
};

/**
 * A fake terminal that reveals its output line by line once scrolled into view.
 * Prints everything immediately when reduced motion is requested.
 */
export default function Terminal({ cmd, lines, status, label = 'retroai · sh' }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setStarted(true);
      setCount(lines.length + 1);
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setStarted(true);
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [lines.length]);

  useEffect(() => {
    if (!started || count > lines.length) return;
    const id = window.setTimeout(() => setCount((c) => c + 1), count === 0 ? 260 : 520);
    return () => window.clearTimeout(id);
  }, [started, count, lines.length]);

  return (
    <div className={styles.term} ref={ref}>
      <div className={styles.bar}>
        <span className={styles.pips} aria-hidden="true">
          <span className={styles.pip} />
          <span className={styles.pip} />
          <span className={styles.pip} />
        </span>
        <span className={styles.barLabel}>{label}</span>
      </div>
      <div className={styles.body}>
        <p className={styles.cmd}>{cmd}</p>
        {lines.slice(0, Math.max(0, count - 1)).map((line) => (
          <p className={styles.line} key={line}>
            <span>{line}</span>
          </p>
        ))}
        {count <= lines.length && <span className={styles.caret} aria-hidden="true" />}
        {count > lines.length && (
          <p className={styles.status}>
            <span className="dot" aria-hidden="true" />
            {status}
          </p>
        )}
      </div>
    </div>
  );
}
