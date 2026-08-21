'use client';

import { useEffect, useRef, useState, type ElementType, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  delay?: number;
  as?: ElementType;
  className?: string;
  style?: React.CSSProperties;
};

/** Fades content in the first time it enters the viewport. */
export default function Reveal({
  children,
  delay = 0,
  as: Tag = 'div',
  className = '',
  style,
}: Props) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || shown) return;

    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );

    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  return (
    <Tag
      ref={ref}
      className={`reveal ${shown ? 'is-in' : ''} ${className}`.trim()}
      style={{ ...style, '--d': `${delay}ms` } as React.CSSProperties}
    >
      {children}
    </Tag>
  );
}
