import Link from 'next/link';
import { services } from '@/lib/site';
import styles from './Hero.module.css';

export default function Hero() {
  return (
    <section className={styles.hero}>
      <div className={styles.bg} aria-hidden="true" />

      <div className="wrap">
        <div className={styles.top}>
          <span className="cap cap--ok">
            <span className="dot" aria-hidden="true" />
            Taking new projects · worldwide
          </span>
          <span className="mono">Est. 2021 · remote-first studio</span>
        </div>

        <h1 className={styles.title}>
          We build software that <em>runs itself</em>.
        </h1>

        <div className={styles.below}>
          <div className="stack-lg">
            <p className="lede">
              RetroAI is a product studio for <span className="hi">websites</span>,{' '}
              <span className="hi">applications</span>, <span className="hi">automation</span> and{' '}
              <span className="hi">AI development</span>. We design it, build it, and keep it
              running in production.
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
