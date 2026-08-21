import type { Metadata } from 'next';
import Link from 'next/link';
import CTA from '@/components/CTA';
import Reveal from '@/components/Reveal';
import { processSteps } from '@/lib/content';
import inner from '../inner.module.css';

export const metadata: Metadata = {
  title: 'Process',
  description:
    'How RetroAI runs a project: scope, architect, build, ship, operate — with weekly demos and no dark period.',
  alternates: { canonical: '/process' },
};

const principles = [
  {
    index: '01',
    title: 'The scope is written down',
    body: 'If it is not in the scope document, it is not in the build. Changes are welcome, priced and re-signed — never silently absorbed.',
  },
  {
    index: '02',
    title: 'You see it every week',
    body: 'A clickable staging environment and a short demo, every week, from week three. No status reports about work you cannot inspect.',
  },
  {
    index: '03',
    title: 'The eval comes first',
    body: 'For anything AI-shaped, we build the measurement before the feature. Otherwise nobody can tell whether it is getting better.',
  },
  {
    index: '04',
    title: 'You own everything',
    body: 'Your repositories, your cloud accounts, your API keys. We work inside your infrastructure and leave a runbook behind.',
  },
];

export default function ProcessPage() {
  return (
    <>
      <section className={`page-head ${inner.hero}`}>
        <div className={inner.heroBg} aria-hidden="true" />
        <div className="wrap">
          <p className={inner.crumb}>
            <Link href="/">Home</Link> / Process
          </p>
          <div className="page-head__grid">
            <div className="stack-lg">
              <p className="eyebrow">How we run</p>
              <h1 className="h1">
                Five phases,
                <br />
                <span className="dim">nothing hidden.</span>
              </h1>
            </div>
            <p className="lede">
              A typical build runs eight to ten weeks from first call to production. Here is exactly
              what happens in each week, and what you hold at the end of it.
            </p>
          </div>
        </div>
      </section>

      <section className="section section--flush">
        <div className="wrap">
          {processSteps.map((step) => (
            <Reveal key={step.index} className={inner.block}>
              <div className="stack">
                <div className="meta-row">
                  <span className="amber">{step.index}</span>
                  <span>{step.duration}</span>
                </div>
                <h2 className={inner.blockTitle}>{step.title}</h2>
              </div>
              <div className="stack-lg">
                <p className="body-text">{step.body}</p>
                <div>
                  <p className="mono dim" style={{ marginBottom: '0.9rem' }}>
                    You leave with
                  </p>
                  <ul className={inner.checkList}>
                    {step.outputs.map((o) => (
                      <li className={inner.checkItem} key={o}>
                        {o}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="head">
            <Reveal className="stack">
              <p className="eyebrow">Ground rules</p>
              <h2 className="h2">
                Four things we <span className="dim">do not bend on.</span>
              </h2>
            </Reveal>
          </div>
          <div className={inner.cards}>
            {principles.map((p, i) => (
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

      <CTA title="Week one starts with a call." sub="Thirty minutes, no deck." />
    </>
  );
}
