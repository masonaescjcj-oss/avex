import Link from 'next/link';
import { site } from '@/lib/site';
import Reveal from './Reveal';
import styles from './CTA.module.css';

const channels = [
  { label: 'Email', value: site.contact.email, href: `mailto:${site.contact.email}`, ext: false },
  { label: 'Telegram', value: site.contact.telegramHandle, href: site.contact.telegram, ext: true },
  { label: 'Channel', value: site.contact.channelHandle, href: site.contact.channel, ext: true },
];

export default function CTA({
  title = 'Half of your operation can run itself.',
  sub = 'We build that half.',
}: {
  title?: string;
  sub?: string;
}) {
  return (
    <section className={styles.cta}>
      <div className="wrap">
        <div className={styles.inner}>
          <Reveal className="stack-lg">
            <p className="eyebrow">Next step</p>
            <h2 className={styles.title}>
              {title} <span className="dim">{sub}</span>
            </h2>
            <div className="btn-row">
              <Link href="/contact" className="btn btn--solid">
                <span>Start a project</span>
                <span aria-hidden="true">→</span>
              </Link>
              <Link href="/process" className="btn btn--ghost">
                <span>How we work</span>
              </Link>
            </div>
          </Reveal>

          <Reveal delay={120}>
            <div className={styles.channels}>
              {channels.map((c) => (
                <a
                  key={c.label}
                  className={styles.channel}
                  href={c.href}
                  {...(c.ext ? { target: '_blank', rel: 'noreferrer' } : {})}
                >
                  <span className={styles.channelLabel}>{c.label}</span>
                  <span className={styles.channelValue}>{c.value}</span>
                  <span className="mono dim" style={{ marginLeft: 'auto' }} aria-hidden="true">
                    ↗
                  </span>
                </a>
              ))}
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
