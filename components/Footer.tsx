import Link from 'next/link';
import { nav, services, site } from '@/lib/site';
import Clock from './Clock';
import styles from './Footer.module.css';

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className="wrap">
        <div className={styles.big} aria-hidden="true">
          RETRO<span className={styles.bigAi}>AI</span>
        </div>

        <div className={styles.cols}>
          <div>
            <p className={styles.colTitle}>Services</p>
            <ul className={styles.list}>
              {services.map((s) => (
                <li key={s.slug}>
                  <Link className={styles.item} href={`/services#${s.slug}`}>
                    {s.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className={styles.colTitle}>Studio</p>
            <ul className={styles.list}>
              {nav.slice(2).map((item) => (
                <li key={item.href}>
                  <Link className={styles.item} href={item.href}>
                    {item.label}
                  </Link>
                </li>
              ))}
              <li>
                <Link className={styles.item} href="/status">
                  Status
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className={styles.colTitle}>Contact</p>
            <ul className={styles.list}>
              <li>
                <a className={styles.item} href={`mailto:${site.contact.email}`}>
                  {site.contact.email}
                </a>
              </li>
              <li>
                <a
                  className={styles.item}
                  href={site.contact.telegram}
                  target="_blank"
                  rel="noreferrer"
                >
                  Telegram {site.contact.telegramHandle} ↗
                </a>
              </li>
            </ul>
          </div>

          <div>
            <p className={styles.colTitle}>Availability</p>
            <div className="stack-sm">
              <span className="mono" style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
                <span className="dot" aria-hidden="true" />
                <span className="cyan">Taking new projects</span>
              </span>
              <span className="mono dim">Remote-first · worldwide</span>
              <span className="mono dim">Reply within one business day</span>
            </div>
          </div>
        </div>

        <div className={styles.bottom}>
          <span className="mono dim">
            © {new Date().getFullYear()} {site.name} — {site.domain}
          </span>
          <span className="meta-row">
            <Link href="/status" className="arrow-link">
              All systems normal
            </Link>
            <Clock />
          </span>
        </div>
      </div>
    </footer>
  );
}
