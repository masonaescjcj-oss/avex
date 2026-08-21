import Link from 'next/link';
import { nav } from '@/lib/site';

export default function NotFound() {
  return (
    <section
      style={{
        minHeight: '80svh',
        display: 'grid',
        placeItems: 'center',
        paddingTop: 'var(--nav-h)',
      }}
    >
      <div className="wrap" style={{ textAlign: 'center' }}>
        <p className="mono amber" style={{ marginBottom: '1.5rem' }}>
          Error 404 · route not found
        </p>
        <h1
          className="h-display"
          style={{ color: 'transparent', WebkitTextStroke: '1px rgba(237,234,227,0.28)' }}
        >
          404
        </h1>
        <p className="lede" style={{ margin: '1.75rem auto 2.25rem', maxWidth: '38ch' }}>
          This page never shipped. Everything that did is one of these:
        </p>
        <div
          className="btn-row"
          style={{ justifyContent: 'center', maxWidth: '44rem', marginInline: 'auto' }}
        >
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="btn btn--ghost">
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
