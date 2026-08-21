import Link from 'next/link';
import CTA from '@/components/CTA';
import Counter from '@/components/Counter';
import Hero from '@/components/Hero';
import Marquee from '@/components/Marquee';
import Reveal from '@/components/Reveal';
import Terminal from '@/components/Terminal';
import { projects } from '@/lib/content';
import { processSteps } from '@/lib/content';
import { services, stack, stats } from '@/lib/site';
import styles from './home.module.css';

const receiptLines = [
  { label: 'Websites', qty: '24' },
  { label: 'Applications', qty: '18' },
  { label: 'Automations', qty: '120' },
  { label: 'AI systems', qty: '31' },
  { label: 'Rented backbone', qty: '00' },
];

export default function HomePage() {
  return (
    <>
      <Hero />

      <Marquee items={stack} />

      {/* ---------- who we are ---------- */}
      <section className="section">
        <div className="wrap">
          <div className={styles.receiptWrap}>
            <Reveal className="stack-lg">
              <p className="eyebrow">01 · Who we are</p>
              <h2 className="h2">
                Studios hand you a deck.
                <br />
                <span className="dim">We hand you a receipt.</span>
              </h2>
              <p className="body-text">
                RetroAI is a small, senior team. No account managers, no handoff to a junior team
                after the pitch — the people who scope your project are the people who build it.
              </p>
              <p className="body-text">
                We work in four disciplines that keep overlapping in practice: a site needs an app
                behind it, the app needs the manual work automated, and the automation gets better
                once a model is doing the judgement calls. So we do all four, and we stay on to
                operate what we ship.
              </p>
              <div className="btn-row">
                <Link href="/about" className="arrow-link">
                  About the studio →
                </Link>
                <Link href="/process" className="arrow-link">
                  Our process →
                </Link>
              </div>
            </Reveal>

            <Reveal delay={140}>
              <div className={styles.receipt}>
                <div className={styles.receiptHead}>
                  <p className={styles.receiptTitle}>RETROAI</p>
                  <p className={styles.receiptDim}>WEB · APP · AUTOMATION · AI</p>
                  <p className={styles.receiptDim}>retroai.agency · open 24/7</p>
                </div>
                <hr className={styles.receiptRule} />
                <p className={styles.receiptLine}>
                  <span>Ticket</span>
                  <span>WHO-WE-ARE</span>
                </p>
                <p className={styles.receiptLine}>
                  <span>Since</span>
                  <span>2021</span>
                </p>
                <hr className={styles.receiptRule} />
                {receiptLines.map((line) => (
                  <p className={styles.receiptLine} key={line.label}>
                    <span>{line.label}</span>
                    <b>{line.qty}</b>
                  </p>
                ))}
                <hr className={styles.receiptRule} />
                <p className={`${styles.receiptLine} ${styles.receiptTotal}`}>
                  <span>Total due</span>
                  <span>0.00</span>
                </p>
                <p className={styles.receiptDim} style={{ textAlign: 'center' }}>
                  ( it pays for itself )
                </p>
                <hr className={styles.receiptRule} />
                <p className={styles.receiptHead} style={{ fontSize: '0.62rem' }}>
                  Thank you for scrolling
                  <br />
                  reprints free
                </p>
                <div className={styles.receiptBar} aria-hidden="true" />
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ---------- services ---------- */}
      <section className="section" id="services">
        <div className="wrap">
          <div className="head head--split">
            <Reveal className="stack">
              <p className="eyebrow">02 · What we do</p>
              <h2 className="h2">
                Four disciplines.
                <br />
                <span className="dim">One team that ships them.</span>
              </h2>
            </Reveal>
            <Reveal delay={120}>
              <p className="lede">
                Each of these is something we design, build and then operate for real customers —
                with the numbers to show for it.
              </p>
            </Reveal>
          </div>

          {services.map((service, i) => (
            <Reveal key={service.slug} className={styles.service} delay={i * 60}>
              <div id={service.slug} className={styles.serviceIndex}>
                {service.index}
              </div>
              <div className="stack">
                <h3 className={styles.serviceTitle}>{service.title}</h3>
                <p className="lede" style={{ fontSize: '1rem' }}>
                  {service.lede}
                </p>
                <p className="body-text" style={{ fontSize: '0.95rem' }}>
                  {service.body}
                </p>
                <div className="tags">
                  {service.tags.map((tag) => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                <Link href={`/services#${service.slug}`} className="arrow-link">
                  What you get →
                </Link>
              </div>
              <Terminal
                cmd={service.terminal.cmd}
                lines={service.terminal.lines}
                status={service.terminal.status}
                label={`${service.id} · live`}
              />
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- stats ---------- */}
      <section className="section">
        <div className="wrap">
          <div className="head">
            <Reveal className="stack">
              <p className="eyebrow">03 · Running tally</p>
              <h2 className="h2">
                Measured, not <span className="dim">estimated.</span>
              </h2>
            </Reveal>
          </div>
          <Reveal>
            <div className={styles.stats}>
              {stats.map((stat) => (
                <div className={styles.stat} key={stat.label}>
                  <p className={styles.statValue}>
                    <Counter value={stat.value} />
                  </p>
                  <p className={styles.statLabel}>{stat.label}</p>
                  {stat.note && <p className={styles.statNote}>{stat.note}</p>}
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ---------- work ---------- */}
      <section className="section">
        <div className="wrap">
          <div className="head head--split">
            <Reveal className="stack">
              <p className="eyebrow">04 · Selected work</p>
              <h2 className="h2">
                Systems in <span className="dim">production.</span>
              </h2>
            </Reveal>
            <Reveal delay={100}>
              <div className="stack">
                <p className="lede">
                  Six of the builds we can talk about publicly, with the metric the client actually
                  cared about.
                </p>
                <Link href="/work" className="arrow-link">
                  All work →
                </Link>
              </div>
            </Reveal>
          </div>

          <div>
            {projects.slice(0, 4).map((project, i) => (
              <Reveal key={project.slug} delay={i * 50}>
                <Link href={`/work/${project.slug}`} className={styles.workRow}>
                  <span className={styles.workIdx}>{project.index}</span>
                  <span className={styles.workName}>{project.name}</span>
                  <span className={styles.workSummary}>{project.summary}</span>
                  <span className="mono dim">
                    {project.sector} · {project.region}
                  </span>
                  <span className="mono amber" aria-hidden="true">
                    ↗
                  </span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- process ---------- */}
      <section className="section">
        <div className="wrap">
          <div className="head head--split">
            <Reveal className="stack">
              <p className="eyebrow">05 · How it goes</p>
              <h2 className="h2">
                Five phases.
                <br />
                <span className="dim">No dark period.</span>
              </h2>
            </Reveal>
            <Reveal delay={100}>
              <div className="stack">
                <p className="lede">
                  You see a working staging environment from week three, and a demo every week after
                  that.
                </p>
                <Link href="/process" className="arrow-link">
                  Full process →
                </Link>
              </div>
            </Reveal>
          </div>

          <div className={styles.steps}>
            {processSteps.map((step, i) => (
              <Reveal key={step.index} className={styles.step} delay={i * 50}>
                <span className="mono amber">{step.index}</span>
                <span className={styles.stepTitle}>{step.title}</span>
                <span className={styles.workSummary}>{step.body}</span>
                <span className="mono dim">{step.duration}</span>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <CTA />
    </>
  );
}
