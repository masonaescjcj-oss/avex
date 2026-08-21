'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import { useReducedMotion, useScrollProgress } from '@/lib/hooks';
import { site } from '@/lib/site';
import s from './Receipt.module.css';

const items = [
  { label: 'Websites', qty: '24' },
  { label: 'Applications', qty: '18' },
  { label: 'Automations', qty: '120' },
  { label: 'AI systems', qty: '31' },
];

/**
 * The studio's manifesto, printed rather than pitched. Rows appear in order as
 * the block scrolls through the viewport, so the total and the line that
 * explains it are always read together.
 */
export default function Receipt() {
  const [ref, progress] = useScrollProgress<HTMLDivElement>();
  const reduced = useReducedMotion();
  const innerRef = useRef<HTMLDivElement>(null);
  // Bottom edge of each row, so the paper can be cut to the printed height.
  const [edges, setEdges] = useState<number[]>([]);

  const rows: React.ReactNode[] = [
    <div className={s.head} key="head">
      <p className={s.title}>RETROAI</p>
      <p className={s.dim}>Web · App · Automation · AI</p>
      <p className={s.dim}>
        {site.domain} · open 24/7
      </p>
    </div>,
    <hr className={s.rule} key="r1" />,
    <p className={s.line} key="ticket">
      <span>Ticket</span>
      <span>Who-we-are</span>
    </p>,
    <p className={s.line} key="since">
      <span>Operating since</span>
      <span>{site.founded}</span>
    </p>,
    <hr className={s.rule} key="r2" />,
    ...items.map((item) => (
      <p className={s.line} key={item.label}>
        <span>{item.label}</span>
        <b>{item.qty}</b>
      </p>
    )),
    <hr className={s.rule} key="r3" />,
    <p className={`${s.line} ${s.total}`} key="total">
      <span>Total due</span>
      <span>0.00</span>
    </p>,
    <p className={s.pays} key="pays">
      ( the work pays for itself )
    </p>,
    <hr className={s.rule} key="r4" />,
    <p className={`${s.head} ${s.dim}`} key="thanks" style={{ fontSize: '0.62rem' }}>
      Thank you for scrolling
      <br />
      Reprints free
    </p>,
    <div className={s.barcode} key="barcode" aria-hidden="true" />,
  ];

  // Reduced motion prints the whole thing at once.
  const printed = reduced ? rows.length : Math.floor(progress * (rows.length + 1));
  const done = printed >= rows.length;
  const percent = Math.round(Math.min(1, progress) * 100);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;

    const measure = () => {
      const items = Array.from(el.querySelectorAll<HTMLElement>('[data-row]'));
      const pad = parseFloat(getComputedStyle(el).paddingBottom) || 0;
      setEdges(items.map((row, i) =>
        i === items.length - 1
          ? row.offsetTop + row.offsetHeight + pad
          : row.offsetTop + row.offsetHeight,
      ));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const full = edges.length ? edges[edges.length - 1] : undefined;
  // Before measurement the paper renders at full height, so a JS-less or
  // pre-hydration view still shows a complete receipt.
  const height = !edges.length || done ? full : edges[Math.max(0, printed - 1)] ?? 0;

  return (
    <div className={s.frame}>
      <div className={s.printer}>
        <span>RetroAI thermal · RA-26</span>
        <span className={s.slot} aria-hidden="true">
          <span className={s.slotFill} style={{ width: `${percent}%` }} />
        </span>
        <span className={s.printerState} data-done={done ? '1' : '0'}>
          {done ? 'Complete' : printed === 0 ? 'Idle · ready' : `Printing ${percent}%`}
        </span>
      </div>

      <div className={s.reserve} ref={ref} style={{ minHeight: full }}>
        <div className={s.paper} style={{ height }}>
          <div className={s.inner} ref={innerRef}>
            {rows.map((row, i) => (
              <div className={s.row} key={i} data-row="" data-on={printed > i ? '1' : '0'}>
                {row}
              </div>
            ))}
          </div>
          {!reduced && !done && printed > 0 && <div className={s.headBar} aria-hidden="true" />}
        </div>
      </div>

      <p className={s.hint} data-hidden={printed > 0 ? '1' : '0'}>
        <span>Scroll to print</span>
        <span aria-hidden="true" />
      </p>
    </div>
  );
}
