import type { Metadata } from 'next';
import Link from 'next/link';
import CTA from '@/components/CTA';
import Reveal from '@/components/Reveal';
import { posts } from '@/lib/content';
import inner from '../inner.module.css';

export const metadata: Metadata = {
  title: 'Journal',
  description:
    'Notes from the RetroAI studio on AI development, automation audits, evals and shipping fast websites.',
  alternates: { canonical: '/blog' },
};

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export default function BlogPage() {
  const sorted = [...posts].sort((a, b) => b.date.localeCompare(a.date));

  return (
    <>
      <section className={`page-head ${inner.hero}`}>
        <div className={inner.heroBg} aria-hidden="true" />
        <div className="wrap">
          <p className={inner.crumb}>
            <Link href="/">Home</Link> / Journal
          </p>
          <div className="page-head__grid">
            <div className="stack-lg">
              <p className="eyebrow">Journal</p>
              <h1 className="h1">
                Notes from
                <br />
                <span className="dim">inside the build.</span>
              </h1>
            </div>
            <p className="lede">
              Things we learned the expensive way, written up so the next client does not have to
              pay for the lesson twice.
            </p>
          </div>
        </div>
      </section>

      <section className="section section--flush">
        <div className="wrap">
          <div className={inner.rows}>
            {sorted.map((post, i) => (
              <Reveal key={post.slug} delay={i * 40}>
                <Link href={`/blog/${post.slug}`} className={inner.row}>
                  <div className="meta-row">
                    <span className="amber">{post.category}</span>
                    <span>{fmt(post.date)}</span>
                    <span>{post.readingTime}</span>
                  </div>
                  <h2
                    className={inner.rowTitle}
                    style={{ fontSize: 'clamp(1.3rem, 3.2vw, 2.15rem)', maxWidth: '30ch' }}
                  >
                    {post.title}
                  </h2>
                  <p className={inner.rowBody} style={{ maxWidth: '62ch' }}>
                    {post.excerpt}
                  </p>
                  <span className="arrow-link">Read →</span>
                </Link>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <CTA title="Rather talk than read?" sub="One call, thirty minutes." />
    </>
  );
}
