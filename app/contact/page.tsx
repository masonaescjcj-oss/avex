import type { Metadata } from 'next';
import Link from 'next/link';
import ContactForm from '@/components/ContactForm';
import Reveal from '@/components/Reveal';
import { site } from '@/lib/site';
import inner from '../inner.module.css';
import styles from './contact.module.css';

export const metadata: Metadata = {
  title: 'Contact',
  description:
    'Start a project with RetroAI — Telegram @isaacar, info@retroai.agency, or send a brief straight from this page.',
  alternates: { canonical: '/contact' },
};

const channels = [
  {
    label: 'Telegram',
    value: site.contact.telegramHandle,
    href: site.contact.telegram,
    note: 'Fastest — usually answered same day',
    ext: true,
  },
  {
    label: 'Email',
    value: site.contact.email,
    href: `mailto:${site.contact.email}`,
    note: 'For briefs, documents and contracts',
    ext: false,
  },
  {
    label: 'Channel',
    value: site.contact.channelHandle,
    href: site.contact.channel,
    note: 'Build notes and launches',
    ext: true,
  },
];

const faqs = [
  {
    q: 'What does a project cost?',
    a: 'A focused site starts around $4–8k. An application MVP is typically $15–40k. Automation work is priced against the hours it removes, so it usually pays back inside a quarter. You get a fixed number after the scoping call, not a range.',
  },
  {
    q: 'How fast can you start?',
    a: 'Scoping calls happen within a few days. Build slots usually open two to three weeks out, and we will tell you honestly if the next one is further away than that.',
  },
  {
    q: 'Do you work with existing codebases?',
    a: 'Yes, and often. Audit-and-rescue is a standing engagement type: two weeks to diagnose a stalled build and hand you a plan any team can execute.',
  },
  {
    q: 'Who owns the code?',
    a: 'You do, from the first commit. We work inside your repositories and cloud accounts, and leave a runbook behind so your team is never locked to us.',
  },
];

export default function ContactPage() {
  return (
    <>
      <section className={`page-head ${inner.hero}`}>
        <div className={inner.heroBg} aria-hidden="true" />
        <div className="wrap">
          <p className={inner.crumb}>
            <Link href="/">Home</Link> / Contact
          </p>
          <div className="page-head__grid">
            <div className="stack-lg">
              <p className="eyebrow">
                <span className="dot" aria-hidden="true" style={{ marginRight: '0.15rem' }} />
                Taking new projects
              </p>
              <h1 className="h1">
                Tell us what
                <br />
                <span className="dim">needs building.</span>
              </h1>
            </div>
            <p className="lede">
              A sentence about the problem is enough to start. We reply within one business day, and
              the first call is thirty minutes with the person who would run your build.
            </p>
          </div>
        </div>
      </section>

      <section className="section section--flush">
        <div className="wrap">
          <div className={styles.split}>
            <Reveal className="stack-lg">
              <p className="eyebrow">Project brief</p>
              <ContactForm />
            </Reveal>

            <Reveal delay={120} className="stack-lg">
              <div>
                <p className="eyebrow" style={{ marginBottom: '1.35rem' }}>
                  Direct channels
                </p>
                <div className={styles.channels}>
                  {channels.map((c) => (
                    <a
                      key={c.label}
                      className={styles.channel}
                      href={c.href}
                      {...(c.ext ? { target: '_blank', rel: 'noreferrer' } : {})}
                    >
                      <span className="mono dim">{c.label}</span>
                      <span className={styles.channelValue}>{c.value}</span>
                      <span className={styles.channelNote}>{c.note}</span>
                    </a>
                  ))}
                </div>
              </div>

              <div className="panel">
                <p className="mono amber" style={{ marginBottom: '1rem' }}>
                  What happens next
                </p>
                <ul className={inner.checkList}>
                  <li className={inner.checkItem}>We reply within one business day</li>
                  <li className={inner.checkItem}>Thirty-minute call, no deck, no sales team</li>
                  <li className={inner.checkItem}>Written scope and a fixed price within a week</li>
                  <li className={inner.checkItem}>Build starts once you sign — nothing before</li>
                </ul>
              </div>

              <div className="panel">
                <p className="mono dim" style={{ marginBottom: '0.85rem' }}>
                  Studio
                </p>
                <div className="stack-sm">
                  <span className="mono">{site.domain}</span>
                  <span className="mono dim">Remote-first · worldwide delivery</span>
                  <span className="mono dim">Working hours 09:00 – 19:00, Mon – Fri</span>
                  <span className="mono cyan">Async replies most weekends</span>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="wrap">
          <div className="head head--split">
            <Reveal className="stack">
              <p className="eyebrow">Before you write</p>
              <h2 className="h2">
                The four questions <span className="dim">we always get.</span>
              </h2>
            </Reveal>
          </div>
          <div className={inner.rows}>
            {faqs.map((f, i) => (
              <Reveal
                key={f.q}
                className={inner.row}
                delay={i * 50}
                style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}
              >
                <h3 className={inner.rowTitle} style={{ maxWidth: '34ch' }}>
                  {f.q}
                </h3>
                <p className={inner.rowBody} style={{ maxWidth: '68ch' }}>
                  {f.a}
                </p>
              </Reveal>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
