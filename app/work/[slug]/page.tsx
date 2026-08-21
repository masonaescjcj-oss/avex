import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import CTA from '@/components/CTA';
import Reveal from '@/components/Reveal';
import { projects } from '@/lib/content';
import inner from '../../inner.module.css';

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return projects.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const project = projects.find((p) => p.slug === slug);
  if (!project) return { title: 'Case study not found' };

  return {
    title: `${project.name} — case study`,
    description: project.summary,
    alternates: { canonical: `/work/${project.slug}` },
    openGraph: { title: `${project.name} — RetroAI case study`, description: project.summary },
  };
}

export default async function ProjectPage({ params }: Params) {
  const { slug } = await params;
  const project = projects.find((p) => p.slug === slug);
  if (!project) notFound();

  const index = projects.findIndex((p) => p.slug === slug);
  const next = projects[(index + 1) % projects.length];

  return (
    <>
      <section className={`page-head ${inner.hero}`}>
        <div className={inner.heroBg} aria-hidden="true" />
        <div className="wrap">
          <p className={inner.crumb}>
            <Link href="/">Home</Link> / <Link href="/work">Work</Link> / {project.name}
          </p>
          <div className="page-head__grid">
            <div className="stack-lg">
              <div className="meta-row">
                <span className="amber">{project.index}</span>
                <span>{project.sector}</span>
                <span>{project.region}</span>
                <span>{project.year}</span>
              </div>
              <h1 className="h1">{project.name}</h1>
            </div>
            <div className="stack">
              <p className="lede">{project.summary}</p>
              <div className="tags">
                {project.discipline.map((d) => (
                  <span className="tag" key={d}>
                    {d}
                  </span>
                ))}
                <span className="tag tag--live">{project.status}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal>
            <p className="eyebrow" style={{ marginBottom: '2rem' }}>
              Outcome
            </p>
            <div className={inner.metrics}>
              {project.metrics.map((m) => (
                <div className={inner.metric} key={m.label}>
                  <p className={inner.metricValue}>{m.value}</p>
                  <p className={inner.metricLabel}>{m.label}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal className={inner.block} style={{ borderTop: 0, paddingTop: 0 }}>
            <div className="stack">
              <p className="eyebrow">The brief</p>
              <h2 className={inner.blockTitle}>What they came with</h2>
            </div>
            <div className="stack-lg">
              <p className="body-text">
                {project.name} arrived with a process that worked, badly. The team was competent and
                the demand was there — what was missing was software that could carry the volume
                without a person copying values between two windows.
              </p>
              <p className="body-text">
                We spent the first week counting: how often each step ran, how long it took, and
                what it cost when it went wrong. That audit set the order of work for everything
                that followed.
              </p>
            </div>
          </Reveal>

          <Reveal className={inner.block}>
            <div className="stack">
              <p className="eyebrow">What we built</p>
              <h2 className={inner.blockTitle}>The system</h2>
            </div>
            <div className="stack-lg">
              <p className="body-text">
                {project.discipline.join(' and ')} across a single codebase, deployed on
                infrastructure the client owns. Every automated step keeps an audit trail and a human
                override, so the team can inspect any decision after the fact.
              </p>
              <ul className={inner.checkList}>
                <li className={inner.checkItem}>
                  Architecture and data model designed against the audited process
                </li>
                <li className={inner.checkItem}>
                  Staging environment from week three, weekly demos to the operators
                </li>
                <li className={inner.checkItem}>
                  Monitoring, alerting and a runbook handed to the internal team
                </li>
                <li className={inner.checkItem}>
                  Ongoing operation on retainer, with a monthly report against the metrics above
                </li>
              </ul>
            </div>
          </Reveal>

          <Reveal className={inner.block}>
            <div className="stack">
              <p className="eyebrow">Where it stands</p>
              <h2 className={inner.blockTitle}>Today</h2>
            </div>
            <div className="stack-lg">
              <p className="body-text">
                The system is {project.status.toLowerCase()} and the numbers above are measured on a
                trailing window, not projected. The next phase on the roadmap widens coverage to the
                adjacent process the audit flagged as second most expensive.
              </p>
              <Link href="/contact" className="btn btn--solid" style={{ width: 'fit-content' }}>
                <span>Start something similar</span>
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <p className="eyebrow" style={{ marginBottom: '1.5rem' }}>
            Next case study
          </p>
          <Link href={`/work/${next.slug}`} className={inner.row}>
            <div className="stack-sm">
              <span className="meta-row">
                {next.sector} · {next.region} · {next.year}
              </span>
              <h2 className={inner.rowTitle} style={{ fontSize: 'clamp(1.5rem, 4vw, 2.6rem)' }}>
                {next.name} ↗
              </h2>
              <p className={inner.rowBody} style={{ maxWidth: '58ch' }}>
                {next.summary}
              </p>
            </div>
          </Link>
        </div>
      </section>

      <CTA />
    </>
  );
}
