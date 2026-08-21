import type { Metadata } from 'next';
import Link from 'next/link';
import Reveal from '@/components/Reveal';
import { roles } from '@/lib/content';
import { site } from '@/lib/site';
import inner from '../inner.module.css';

export const metadata: Metadata = {
  title: 'Careers',
  description:
    'Open roles at RetroAI — full-stack, AI and automation engineering plus product design. Remote, senior, no ceremony.',
  alternates: { canonical: '/careers' },
};

const perks = [
  {
    index: '01',
    title: 'Fully remote',
    body: 'Work from wherever you are effective. We overlap four hours a day and write the rest down.',
  },
  {
    index: '02',
    title: 'Ship weekly',
    body: 'Small team, short review cycles. Your work reaches a real user within days, not quarters.',
  },
  {
    index: '03',
    title: 'No ceremony',
    body: 'One planning call a week, one demo. No stand-up theatre, no story points, no status decks.',
  },
  {
    index: '04',
    title: 'Own your surface',
    body: 'You get a discipline, not a ticket queue. Decisions live with the person doing the work.',
  },
];

export default function CareersPage() {
  return (
    <>
      <section className={`page-head ${inner.hero}`}>
        <div className={inner.heroBg} aria-hidden="true" />
        <div className="wrap">
          <p className={inner.crumb}>
            <Link href="/">Home</Link> / Careers
          </p>
          <div className="page-head__grid">
            <div className="stack-lg">
              <p className="eyebrow">We hire builders</p>
              <h1 className="h1">
                Open roles,
                <br />
                <span className="dim">short process.</span>
              </h1>
            </div>
            <div className="stack">
              <p className="lede">
                Two conversations and a paid trial task. No take-home marathons, no panel of six.
                Apply on Telegram or by email — a link to something you built beats a CV.
              </p>
              <div className="btn-row">
                <a
                  className="btn btn--solid"
                  href={site.contact.telegram}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span>Apply on Telegram</span>
                  <span aria-hidden="true">↗</span>
                </a>
                <a className="btn btn--ghost" href={`mailto:${site.contact.email}?subject=Application`}>
                  <span>{site.contact.email}</span>
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section section--flush">
        <div className="wrap">
          <div className="head">
            <Reveal className="stack">
              <p className="eyebrow">{roles.length} open positions</p>
              <h2 className="h2">
                Where we need <span className="dim">hands.</span>
              </h2>
            </Reveal>
          </div>

          <div className={inner.rows}>
            {roles.map((role, i) => (
              <Reveal key={role.title} delay={i * 50}>
                <a
                  className={inner.row}
                  href={`${site.contact.telegram}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <div className="meta-row">
                    <span className="amber">{String(i + 1).padStart(2, '0')}</span>
                    <span>{role.type}</span>
                    <span>{role.location}</span>
                  </div>
                  <h3 className={inner.rowTitle} style={{ fontSize: 'clamp(1.2rem, 2.8vw, 1.9rem)' }}>
                    {role.title}
                  </h3>
                  <p className={inner.rowBody} style={{ maxWidth: '58ch' }}>
                    {role.summary}
                  </p>
                  <div className="tags">
                    {role.stack.map((s) => (
                      <span className="tag" key={s}>
                        {s}
                      </span>
                    ))}
                    <span className="tag tag--live">Apply ↗</span>
                  </div>
                </a>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="head">
            <Reveal className="stack">
              <p className="eyebrow">What it is like</p>
              <h2 className="h2">
                Four things about <span className="dim">working here.</span>
              </h2>
            </Reveal>
          </div>
          <div className={inner.cards}>
            {perks.map((p, i) => (
              <Reveal key={p.index} delay={i * 60}>
                <article className="panel panel--hover" style={{ height: '100%' }}>
                  <span className="panel__corner panel__corner--tl" aria-hidden="true" />
                  <span className="panel__corner panel__corner--br" aria-hidden="true" />
                  <span className={inner.cardIndex}>{p.index}</span>
                  <h3 className={inner.cardTitle}>{p.title}</h3>
                  <p className={inner.cardBody}>{p.body}</p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <Reveal className="stack-lg" style={{ maxWidth: '44rem' }}>
            <p className="eyebrow">Nothing fits?</p>
            <h2 className="h2">
              Send it anyway.
            </h2>
            <p className="body-text">
              If you are strong at something we clearly need and there is no role listed for it,
              write to us. We have opened positions for people before, and we would rather hear from
              you early than not at all.
            </p>
            <div className="btn-row">
              <a
                className="btn btn--solid"
                href={site.contact.telegram}
                target="_blank"
                rel="noreferrer"
              >
                <span>Message {site.contact.telegramHandle}</span>
                <span aria-hidden="true">↗</span>
              </a>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  );
}
