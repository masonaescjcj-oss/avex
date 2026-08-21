import Link from 'next/link';
import { services } from '@/lib/site';
import styles from './Hero.module.css';

export default function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.bg} aria-hidden="true" />
      <div className={styles.gridLines} aria-hidden="true" />

      <div className="wrap">
        <div className={styles.top}>
          <span className={styles.badge}>
            <span className="dot" aria-hidden="true" />
            Taking new projects · worldwide
          </span>
          <span className="mono dim">Est. 2021 · Remote-first studio</span>
        </div>

        <h1 className={styles.title}>
          <span className={styles.titleRow}>
            <span className={styles.titleLine} style={{ '--d': '80ms' } as React.CSSProperties}>
              We build
            </span>
          </span>
          <span className={styles.titleRow}>
            <span className={styles.titleLine} style={{ '--d': '200ms' } as React.CSSProperties}>
              software that
            </span>
          </span>
          <span className={styles.titleRow}>
            <span
              className={`${styles.titleLine} ${styles.outline}`}
              style={{ '--d': '320ms' } as React.CSSProperties}
            >
              runs itself
              <i className={styles.cursor} aria-hidden="true" />
            </span>
          </span>
        </h1>

        <div className={styles.below}>
          <div className="stack-lg">
            <p className="lede">
              RetroAI is a product studio for <span className="hi">websites</span>,{' '}
              <span className="hi">applications</span>, <span className="hi">automation</span> and{' '}
              <span className="hi">AI development</span>. We design it, build it, and keep it running
              in production.
            </p>
            <div className="btn-row">
              <Link href="/contact" className="btn btn--solid">
                <span>Start a project</span>
                <span aria-hidden="true">→</span>
              </Link>
              <Link href="/services" className="btn btn--ghost">
                <span>What we build</span>
              </Link>
            </div>
          </div>

          <div className={styles.services}>
            {services.map((s) => (
              <Link key={s.slug} href={`/services#${s.slug}`} className={styles.serviceRow}>
                <span className={styles.serviceIdx}>{s.index}</span>
                {s.title}
                <span className={styles.serviceArrow} aria-hidden="true">
                  →
                </span>
              </Link>
            ))}
          </div>
        </div>

        <div className={styles.scrollHint}>
          <span>Scroll</span>
          <span aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
