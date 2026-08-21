import type { Metadata } from 'next';
import Link from 'next/link';
import Clock from '@/components/Clock';
import Reveal from '@/components/Reveal';
import { fleet } from '@/lib/content';
import inner from '../inner.module.css';
import styles from './status.module.css';

export const metadata: Metadata = {
  title: 'Status',
  description: 'Operational status of the systems RetroAI runs and operates for clients.',
  alternates: { canonical: '/status' },
  robots: { index: false, follow: true },
};

const window90 = Array.from({ length: 90 }, (_, i) => {
  // A deterministic pattern so server and client render identically.
  const degraded = i === 31 || i === 62;
  return { day: 90 - i, state: degraded ? 'partial' : 'ok' as const };
});

export default function StatusPage() {
  const allGreen = fleet.every((f) => f.state === 'OPERATIONAL');

  return (
    <>
      <section className={`page-head ${inner.hero}`}>
        <div className={inner.heroBg} aria-hidden="true" />
        <div className="wrap">
          <p className={inner.crumb}>
            <Link href="/">Home</Link> / Status
          </p>
          <div className="page-head__grid">
            <div className="stack-lg">
              <p className="eyebrow">
                <span className="dot" aria-hidden="true" style={{ marginRight: '0.15rem' }} />
                {allGreen ? 'All systems operational' : 'Degraded performance'}
              </p>
              <h1 className="h1">
                Everything we run,
                <br />
                <span className="dim">in one place.</span>
              </h1>
            </div>
            <div className="stack">
              <p className="lede">
                Uptime across the platforms we operate on retainer, measured on a trailing 90-day
                window.
              </p>
              <span className="mono dim">
                Last checked <Clock />
              </span>
            </div>
          </div>
        </div>
      </section>

      <section className="section section--flush">
        <div className="wrap">
          <Reveal className="panel" style={{ marginBottom: '2.5rem' }}>
            <div className={styles.summary}>
              <div>
                <p className="mono dim">Trailing 90 days</p>
                <p className={styles.big}>99.96%</p>
              </div>
              <div className={styles.bars} aria-hidden="true">
                {window90.map((d) => (
                  <span key={d.day} className={styles.bar} data-state={d.state} />
                ))}
              </div>
              <div className="meta-row">
                <span>90 days ago</span>
                <span style={{ marginLeft: 'auto' }}>Today</span>
              </div>
            </div>
          </Reveal>

          <div className={inner.rows}>
            {fleet.map((f, i) => (
              <Reveal
                key={f.name}
                className={inner.row}
                delay={i * 40}
                style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
              >
                <div className={styles.serviceRow}>
                  <span className={styles.serviceName}>{f.name}</span>
                  <span className="mono dim">{f.region}</span>
                  <span className="mono dim">{f.uptime} uptime</span>
                  <span className="mono dim">{f.latency} p95</span>
                  <span className={styles.state} data-degraded={f.state !== 'OPERATIONAL'}>
                    <span className="dot" aria-hidden="true" />
                    {f.state}
                  </span>
                </div>
              </Reveal>
            ))}
          </div>

          <Reveal className="stack-lg" style={{ marginTop: 'clamp(2.5rem, 6vw, 4.5rem)' }}>
            <p className="eyebrow">Incident history</p>
            <div className={inner.rows}>
              <div className={inner.row} style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <div className="meta-row">
                  <span className="amber">2026-06-19</span>
                  <span>Resolved in 41 min</span>
                </div>
                <h3 className={inner.rowTitle}>Elevated latency on the AI gateway</h3>
                <p className={inner.rowBody} style={{ maxWidth: '62ch' }}>
                  An upstream model provider degraded for roughly forty minutes. Requests failed over
                  to the secondary provider; no data was lost and no client-facing errors were
                  returned.
                </p>
              </div>
              <div className={inner.row} style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
                <div className="meta-row">
                  <span className="amber">2026-04-08</span>
                  <span>Resolved in 12 min</span>
                </div>
                <h3 className={inner.rowTitle}>Automation worker backlog</h3>
                <p className={inner.rowBody} style={{ maxWidth: '62ch' }}>
                  A malformed supplier feed filled a retry queue. The queue drained after the parser
                  was patched, and feed validation now rejects the malformed shape at intake.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
