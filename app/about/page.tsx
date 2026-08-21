import type { Metadata } from 'next';
import Link from 'next/link';
import CTA from '@/components/CTA';
import Counter from '@/components/Counter';
import Reveal from '@/components/Reveal';
import { services, site, stats } from '@/lib/site';
import inner from '../inner.module.css';
import home from '../home.module.css';

export const metadata: Metadata = {
  title: 'About',
  description:
    'RetroAI is a remote-first product studio of senior engineers and designers building websites, applications, automation and AI systems.',
  alternates: { canonical: '/about' },
};

const team = [
  {
    initials: 'IS',
    name: 'Isaac',
    role: 'Founder · Engineering',
    body: 'Scopes every project and stays on it. Architecture, AI systems and the awkward conversations about what not to build.',
    handle: site.contact.telegramHandle,
  },
  {
    initials: 'PD',
    name: 'Product & Design',
    role: 'Interface · Systems',
    body: 'Design systems for dense operational software — the dashboards, queues and admin tools people stare at all day.',
    handle: 'in-house',
  },
  {
    initials: 'EN',
    name: 'Engineering',
    role: 'Web · App · Platform',
    body: 'Senior full-stack engineers on Next.js, Node, Python and Postgres. No outsourced delivery team behind the curtain.',
    handle: 'in-house',
  },
  {
    initials: 'OP',
    name: 'Automation & Ops',
    role: 'Pipelines · Uptime',
    body: 'Builds the pipelines and then keeps them alive: retries, audit logs, alerting and the monthly report.',
    handle: 'in-house',
  },
];

const timeline = [
  { year: '2021', title: 'Studio founded', body: 'Two people, contract web work, one office chair between them.' },
  { year: '2023', title: 'Automation practice', body: 'Clients stopped asking for pages and started asking for their manual work to disappear.' },
  { year: '2024', title: 'AI development', body: 'LLM applications, retrieval and agents — with evals attached, from the first project.' },
  { year: '2026', title: 'RetroAI', body: 'New name, same team. Four disciplines under one studio, operating what we ship.' },
];

const beliefs = [
  {
    index: '01',
    title: 'Small and senior',
    body: 'Four to eight people, all of whom write or design. The person on your call is the person doing the work.',
  },
  {
    index: '02',
    title: 'Operate what we build',
    body: 'A studio that never runs its own output learns nothing. We stay on-call, so the design decisions have consequences.',
  },
  {
    index: '03',
    title: 'Boring where it counts',
    body: 'Postgres, server rendering, queues you can inspect. We keep novelty for the parts of the product where it earns its keep.',
  },
  {
    index: '04',
    title: 'Measured claims only',
    body: 'Every number on this site comes from a running system. If we cannot measure it, we do not print it.',
  },
];

export default function AboutPage() {
  return (
    <>
      <section className={`page-head ${inner.hero}`}>
        <div className={inner.heroBg} aria-hidden="true" />
        <div className="wrap">
          <p className={inner.crumb}>
            <Link href="/">Home</Link> / About
          </p>
          <div className="page-head__grid">
            <div className="stack-lg">
              <p className="eyebrow">The studio</p>
              <h1 className="h1">
                Small team,
                <br />
                <span className="dim">long-lived systems.</span>
              </h1>
            </div>
            <p className="lede">
              RetroAI has been building software since {site.founded}, remote-first and deliberately
              small. We take fewer projects than we are asked to, and we keep the ones we take
              running.
            </p>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className={home.stats}>
            {stats.map((stat) => (
              <div className={home.stat} key={stat.label}>
                <p className={home.statValue}>
                  <Counter value={stat.value} />
                </p>
                <p className={home.statLabel}>{stat.label}</p>
                {stat.note && <p className={home.statNote}>{stat.note}</p>}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="head head--split">
            <Reveal className="stack">
              <p className="eyebrow">Who does the work</p>
              <h2 className="h2">
                The people,
                <br />
                <span className="dim">not the org chart.</span>
              </h2>
            </Reveal>
            <Reveal delay={100}>
              <p className="lede">
                We are engineers and designers who ship. Reach the founder directly on Telegram at{' '}
                <a className="amber" href={site.contact.telegram} target="_blank" rel="noreferrer">
                  {site.contact.telegramHandle}
                </a>
                .
              </p>
            </Reveal>
          </div>

          <div className={inner.cards}>
            {team.map((member, i) => (
              <Reveal key={member.name} delay={i * 60}>
                <article className="panel panel--hover" style={{ height: '100%' }}>
                  <span className="panel__corner panel__corner--tl" aria-hidden="true" />
                  <span className="panel__corner panel__corner--br" aria-hidden="true" />
                  <span className={inner.cardIndex}>{member.initials}</span>
                  <h3 className={inner.cardTitle}>{member.name}</h3>
                  <p className="mono dim" style={{ marginBottom: '0.85rem' }}>
                    {member.role}
                  </p>
                  <p className={inner.cardBody}>{member.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="head">
            <Reveal className="stack">
              <p className="eyebrow">History</p>
              <h2 className="h2">
                How we got <span className="dim">here.</span>
              </h2>
            </Reveal>
          </div>
          <div className={inner.rows}>
            {timeline.map((t, i) => (
              <Reveal
                key={t.year}
                className={inner.row}
                delay={i * 50}
                style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
              >
                <div className="meta-row">
                  <span className="amber">{t.year}</span>
                </div>
                <h3 className={inner.rowTitle}>{t.title}</h3>
                <p className={inner.rowBody} style={{ maxWidth: '58ch' }}>
                  {t.body}
                </p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="head">
            <Reveal className="stack">
              <p className="eyebrow">What we believe</p>
              <h2 className="h2">
                Four opinions we <span className="dim">work by.</span>
              </h2>
            </Reveal>
          </div>
          <div className={inner.cards}>
            {beliefs.map((b, i) => (
              <Reveal key={b.index} delay={i * 60}>
                <article className="panel panel--hover" style={{ height: '100%' }}>
                  <span className="panel__corner panel__corner--tl" aria-hidden="true" />
                  <span className="panel__corner panel__corner--br" aria-hidden="true" />
                  <span className={inner.cardIndex}>{b.index}</span>
                  <h3 className={inner.cardTitle}>{b.title}</h3>
                  <p className={inner.cardBody}>{b.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="head head--split">
            <Reveal className="stack">
              <p className="eyebrow">Disciplines</p>
              <h2 className="h2">
                What we can <span className="dim">take on.</span>
              </h2>
            </Reveal>
            <Reveal delay={100}>
              <Link href="/services" className="arrow-link">
                Services in detail →
              </Link>
            </Reveal>
          </div>
          <div className={inner.rows}>
            {services.map((s, i) => (
              <Reveal key={s.slug} delay={i * 50}>
                <Link href={`/services#${s.slug}`} className={inner.row}>
                  <div className="meta-row">
                    <span className="amber">{s.index}</span>
                    <span>{s.tags.join(' · ')}</span>
                  </div>
                  <h3 className={inner.rowTitle}>{s.title}</h3>
                  <p className={inner.rowBody} style={{ maxWidth: '58ch' }}>
                    {s.lede}
                  </p>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <CTA title="Want to work with a team this size?" sub="That is the point." />
    </>
  );
}
