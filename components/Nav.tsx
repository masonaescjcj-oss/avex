'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { nav, site } from '@/lib/site';
import Clock from './Clock';
import styles from './Nav.module.css';

export default function Nav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close the overlay on route change.
  useEffect(() => setOpen(false), [pathname]);

  // Lock scroll and allow Escape to dismiss while the overlay is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <>
      <header className={styles.bar} data-solid={solid || open}>
        <div className={styles.inner}>
          <Link href="/" className={styles.brand} aria-label={`${site.name} — home`}>
            <span className={styles.brandMark}>
              Retro<span className={styles.brandAi}>AI</span>
            </span>
            <span className={styles.brandSub}>Agency</span>
          </Link>

          <nav className={styles.links} aria-label="Primary">
            {nav.slice(1, 7).map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={styles.link}
                data-active={isActive(item.href)}
              >
                {item.label}
              </Link>
            ))}
          </nav>

          <div className={styles.right}>
            <span className={styles.clock} aria-hidden="true">
              <Clock />
            </span>
            <Link href="/contact" className={styles.cta}>
              Start a project
            </Link>
            <button
              type="button"
              className={styles.toggle}
              data-open={open}
              aria-expanded={open}
              aria-controls="menu-overlay"
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Close' : 'Menu'}
              <span className={styles.toggleIcon} aria-hidden="true">
                <span />
                <span />
              </span>
            </button>
          </div>
        </div>
      </header>

      <div id="menu-overlay" className={styles.overlay} data-open={open} aria-hidden={!open}>
        <ul className={styles.overlayList}>
          {nav.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                className={styles.overlayItem}
                data-active={isActive(item.href)}
                tabIndex={open ? 0 : -1}
              >
                <span className={styles.overlayIndex}>{item.index}</span>
                {item.label}
                <span className={styles.overlayNote}>{item.note}</span>
              </Link>
            </li>
          ))}
        </ul>
        <div className={styles.overlayFoot}>
          <a className="arrow-link" href={`mailto:${site.contact.email}`} tabIndex={open ? 0 : -1}>
            {site.contact.email} ↗
          </a>
          <a
            className="arrow-link"
            href={site.contact.telegram}
            target="_blank"
            rel="noreferrer"
            tabIndex={open ? 0 : -1}
          >
            Telegram {site.contact.telegramHandle} ↗
          </a>
        </div>
      </div>
    </>
  );
}
