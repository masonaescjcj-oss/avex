import { ImageResponse } from 'next/og';
import { site } from '@/lib/site';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = `${site.name} — ${site.tagline}`;

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: '#06060a',
          padding: '72px',
          fontFamily: 'sans-serif',
          color: '#edeae3',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '1200px',
            height: '630px',
            background:
              'radial-gradient(600px 400px at 12% 0%, rgba(255,176,32,0.20), rgba(6,6,10,0) 70%)',
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: '18px' }}>
          <div style={{ fontSize: '38px', fontWeight: 700, letterSpacing: '-0.035em', display: 'flex' }}>
            <span>Retro</span>
            <span style={{ color: '#ffb020' }}>AI</span>
          </div>
          <div style={{ fontSize: '17px', letterSpacing: '0.22em', color: 'rgba(237,234,227,0.35)' }}>
            AGENCY
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '26px' }}>
          <div
            style={{
              fontSize: '90px',
              fontWeight: 600,
              lineHeight: 0.94,
              letterSpacing: '-0.045em',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <span>We build software</span>
            <span style={{ color: '#ffb020' }}>that runs itself</span>
          </div>
          <div
            style={{
              fontSize: '22px',
              letterSpacing: '0.16em',
              color: 'rgba(237,234,227,0.5)',
              textTransform: 'uppercase',
            }}
          >
            Website · Application · Automation · AI Development
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '20px',
            letterSpacing: '0.1em',
            color: 'rgba(237,234,227,0.4)',
            borderTop: '1px solid rgba(237,234,227,0.12)',
            paddingTop: '26px',
          }}
        >
          <span>{site.domain}</span>
          <span>{site.contact.email}</span>
        </div>
      </div>
    ),
    size,
  );
}
