import type { Metadata } from 'next';
import Link from 'next/link';
import CTA from '@/components/CTA';
import Reveal from '@/components/Reveal';
import { projects } from '@/lib/content';
import inner from '../inner.module.css';

export const metadata: Metadata = {
  title: 'Work',
  description:
    'Selected RetroAI builds — logistics automation, healthcare platforms, headless commerce, AI support desks and deal-room software.',
  alternates: { canonical: '/work' },
};

export default function WorkPage() {
  return (
    <>
      <section className={`page-head ${inner.hero}`}>
        <div className={inner.heroBg} aria-hidden="true" />
        <div className="wrap">
          <p className={inner.crumb}>
            <Link href="/">Home</Link> / Work
          </p>
          <div className="page-head__grid">
            <div className="stack-lg">
              <p className="eyebrow">Selected work</p>
              <h1 className="h1">
                Shipped,
                <br />
                <span className="dim">and still running.</span>
              </h1>
            </div>
            <div className="stack">
              <p className="lede">
                Six builds we are allowed to describe. Client names are changed where the contract
                requires it; the numbers are not.
              </p>
              <div className="meta-row">
                <span>{projects.length} projects</span>
                <span>6 sectors</span>
                <span>4 regions</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section--flush">
        <div className="wrap">
          <div className={inner.rows}>
            {projects.map((p, i) => (
              <Reveal key={p.slug} delay={i * 40}>
                <Link
                  href={`/work/${p.slug}`}
                  className={inner.row}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr)',
                    gap: '0.85rem',
                  }}
                >
                  <div className="meta-row">
                    <span className="amber">{p.index}</span>
                    <span>{p.sector}</span>
                    <span>{p.region}</span>
                    <span>{p.year}</span>
                    <span className={p.status === 'OPERATING' ? 'cyan' : ''}>{p.status}</span>
                  </div>
                  <h2 className={inner.rowTitle} style={{ fontSize: 'clamp(1.4rem, 3.4vw, 2.4rem)' }}>
                    {p.name}
                  </h2>
                  <p className={inner.rowBody} style={{ maxWidth: '62ch' }}>
                    {p.summary}
                  </p>
                  <div className="tags">
                    {p.discipline.map((d) => (
                      <span className="tag" key={d}>
                        {d}
                      </span>
                    ))}
                    <span className="tag tag--live">Case study ↗</span>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <CTA title="Your project could be the next row." sub="Let’s scope it." />
    </>
  );
}
