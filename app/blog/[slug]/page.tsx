import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import CTA from '@/components/CTA';
import { posts } from '@/lib/content';
import { site } from '@/lib/site';
import inner from '../../inner.module.css';
import styles from './post.module.css';

type Params = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return posts.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  const post = posts.find((p) => p.slug === slug);
  if (!post) return { title: 'Post not found' };

  return {
    title: post.title,
    description: post.excerpt,
    alternates: { canonical: `/blog/${post.slug}` },
    openGraph: {
      type: 'article',
      title: post.title,
      description: post.excerpt,
      publishedTime: post.date,
    },
  };
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

export default async function PostPage({ params }: Params) {
  const { slug } = await params;
  const post = posts.find((p) => p.slug === slug);
  if (!post) notFound();

  const index = posts.findIndex((p) => p.slug === slug);
  const next = posts[(index + 1) % posts.length];

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    author: { '@type': 'Organization', name: site.name, url: site.url },
    publisher: { '@type': 'Organization', name: site.name, url: site.url },
    mainEntityOfPage: `${site.url}/blog/${post.slug}`,
  };

  return (
    <>
      <article>
        <section className={`page-head ${inner.hero}`}>
          <div className={inner.heroBg} aria-hidden="true" />
          <div className="wrap">
            <p className={inner.crumb}>
              <Link href="/">Home</Link> / <Link href="/blog">Journal</Link> / {post.category}
            </p>
            <div className={styles.head}>
              <div className="meta-row">
                <span className="amber">{post.category}</span>
                <span>{fmt(post.date)}</span>
                <span>{post.readingTime} read</span>
              </div>
              <h1 className={styles.title}>{post.title}</h1>
              <p className="lede" style={{ maxWidth: '52ch' }}>
                {post.excerpt}
              </p>
            </div>
          </div>
        </section>

        <section className="section section--flush" style={{ paddingTop: 0 }}>
          <div className="wrap">
            <div className={styles.prose}>
              {post.body.map((para, i) => (
                <p key={i}>{para}</p>
              ))}
            </div>

            <hr className="rule" style={{ margin: '3rem 0 1.5rem' }} />

            <div className={styles.foot}>
              <Link href="/blog" className="arrow-link">
                ← All notes
              </Link>
              <Link href={`/blog/${next.slug}`} className="arrow-link">
                Next: {next.title} →
              </Link>
            </div>
          </div>
        </section>
      </article>

      <CTA title="This is how we would build yours." sub="Talk to us." />

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(schema) }}
      />
    </>
  );
}
