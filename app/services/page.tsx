import type { Metadata } from 'next';
import Link from 'next/link';
import CTA from '@/components/CTA';
import Marquee from '@/components/Marquee';
import Platforms from '@/components/Platforms';
import Reveal from '@/components/Reveal';
import Demo from '@/components/demos/Demos';
import { services, stack } from '@/lib/site';
import inner from '../inner.module.css';

export const metadata: Metadata = {
  title: 'Services',
  description:
    'Website development, application development, automation and AI development — scoped, built and operated by RetroAI.',
  alternates: { canonical: '/services' },
};

const engagements = [
  {
    index: '01',
    title: 'Fixed-scope build',
    body: 'A defined outcome with a written scope, a fixed price and a delivery date. Best for a site, an MVP or a first automation.',
  },
  {
    index: '02',
    title: 'Embedded team',
    body: 'One to four of us inside your sprints for a quarter or more. You get velocity without a hiring cycle.',
  },
  {
    index: '03',
    title: 'Operate & improve',
    body: 'Monthly retainer covering uptime, patches, model swaps, cost tuning and a queue of small features.',
  },
  {
    index: '04',
    title: 'Audit & rescue',
    body: 'Two weeks to diagnose a stalled build or a slow platform, ending in a plan you can hand to anyone.',
  },
];

export default function ServicesPage() {
  return (
    <>
      <section className={`page-head ${inner.hero}`}>
        <div className={inner.heroBg} aria-hidden="true" />
        <div className="wrap">
          <p className={inner.crumb}>
            <Link href="/">Home</Link> / Services
          </p>
          <div className="page-head__grid">
            <div className="stack-lg">
              <p className="eyebrow">Four disciplines</p>
              <h1 className="h1">
                What we build,
                <br />
                <span className="dim">and what you get.</span>
              </h1>
            </div>
            <p className="lede">
              Every engagement ends with something running in production, documented, and owned by
              your team — not a slide deck and an invoice.
            </p>
          </div>
        </div>
      </section>

      <Marquee items={stack} duration={38} />

      <section className="section section--flush">
        <div className="wrap">
          {services.map((service) => (
            <Reveal key={service.slug} className={inner.block}>
              <div id={service.slug} className="stack-lg">
                <p className="eyebrow">{service.index}</p>
                <h2 className={inner.blockTitle}>{service.title}</h2>
                <p className="lede">{service.lede}</p>
                <p className="body-text">{service.body}</p>
                <div className="tags">
                  {service.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <div className="stack-lg">
                <div>
                  <p className="mono dim" style={{ marginBottom: '1rem' }}>
                    Deliverables
                  </p>
                  <ul className={inner.checkList}>
                    {service.deliverables.map((d) => (
                      <li className={inner.checkItem} key={d}>
                        {d}
                      </li>
                    ))}
                  </ul>
                </div>
                <Demo kind={service.demo} />
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="head head--split">
            <Reveal className="stack">
              <p className="eyebrow">Engagements</p>
              <h2 className="h2">
                Four ways to <span className="dim">work with us.</span>
              </h2>
            </Reveal>
            <Reveal delay={100}>
              <p className="lede">
                Not sure which one fits? Describe the problem and we will tell you which of these we
                would propose, and roughly what it costs.
              </p>
            </Reveal>
          </div>

          <div className={inner.cards}>
            {engagements.map((e, i) => (
              <Reveal key={e.index} delay={i * 60}>
                <article className="panel panel--hover" style={{ height: '100%' }}>
                  <span className="panel__corner panel__corner--tl" aria-hidden="true" />
                  <span className="panel__corner panel__corner--br" aria-hidden="true" />
                  <span className={inner.cardIndex}>{e.index}</span>
                  <h3 className={inner.cardTitle}>{e.title}</h3>
                  <p className={inner.cardBody}>{e.body}</p>
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
              <p className="eyebrow">Integrations</p>
              <h2 className="h2">
                What we plug <span className="dim">into.</span>
              </h2>
            </Reveal>
            <Reveal delay={100}>
              <p className="lede">
                Most projects are not greenfield. These are the systems we most often build on,
                extend or replace.
              </p>
            </Reveal>
          </div>
          <Platforms />
        </div>
      </section>

      <CTA title="Tell us what breaks today." sub="We will tell you what it costs to fix." />
    </>
  );
}
