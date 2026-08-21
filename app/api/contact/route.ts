import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const LIMITS = {
  name: 120,
  company: 160,
  contact: 200,
  service: 80,
  budget: 60,
  timeline: 60,
  brief: 5000,
} as const;

type Field = keyof typeof LIMITS;

/**
 * Best-effort throttle. Serverless instances are ephemeral and there may be
 * several at once, so this trims casual repeat submissions rather than
 * providing a real guarantee — the honeypot does the heavier lifting.
 */
const seen = new Map<string, number[]>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function rateLimited(key: string) {
  const now = Date.now();
  const hits = (seen.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  seen.set(key, hits);
  if (seen.size > 500) seen.clear();
  return hits.length > MAX_PER_WINDOW;
}

const escapeHtml = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function clean(value: unknown, field: Field) {
  return typeof value === 'string' ? value.trim().slice(0, LIMITS[field]) : '';
}

export async function POST(request: Request) {
  let payload: Record<string, unknown>;

  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 });
  }

  // Hidden field. Real people leave it empty; most bots fill every input.
  if (clean(payload.company_website, 'company')) {
    return NextResponse.json({ ok: true });
  }

  const enquiry = {
    name: clean(payload.name, 'name'),
    company: clean(payload.company, 'company'),
    contact: clean(payload.contact, 'contact'),
    service: clean(payload.service, 'service'),
    budget: clean(payload.budget, 'budget'),
    timeline: clean(payload.timeline, 'timeline'),
    brief: clean(payload.brief, 'brief'),
  };

  if (!enquiry.name || !enquiry.contact || enquiry.brief.length < 12) {
    return NextResponse.json(
      { ok: false, error: 'Add your name, a way to reach you, and a sentence about the project.' },
      { status: 422 },
    );
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown';

  if (rateLimited(ip)) {
    return NextResponse.json(
      { ok: false, error: 'That is a few submissions in a row — try again shortly.' },
      { status: 429 },
    );
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const resendKey = process.env.RESEND_API_KEY;
  const mailTo = process.env.CONTACT_EMAIL_TO;
  const mailFrom = process.env.CONTACT_EMAIL_FROM;

  // Nothing configured: tell the client so it can fall back to Telegram/mailto.
  if (!token && !resendKey) {
    return NextResponse.json({ ok: false, error: 'not-configured' }, { status: 501 });
  }

  const lines = [
    ['Name', enquiry.name],
    ['Company', enquiry.company],
    ['Reach at', enquiry.contact],
    ['Service', enquiry.service],
    ['Budget', enquiry.budget],
    ['Timeline', enquiry.timeline],
  ].filter(([, value]) => value);

  const results = await Promise.allSettled([
    token && chatId
      ? fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            text: [
              '<b>New project enquiry</b> · retroai.agency',
              '',
              ...lines.map(([label, value]) => `<b>${label}:</b> ${escapeHtml(value)}`),
              '',
              '<b>Brief</b>',
              escapeHtml(enquiry.brief),
            ].join('\n'),
          }),
        }).then(async (r) => {
          if (!r.ok) throw new Error(`telegram ${r.status}: ${await r.text()}`);
        })
      : Promise.reject(new Error('telegram not configured')),

    resendKey && mailTo && mailFrom
      ? fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${resendKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: mailFrom,
            to: [mailTo],
            reply_to: enquiry.contact.includes('@') ? enquiry.contact : undefined,
            subject: `Project enquiry — ${enquiry.service || 'general'}${
              enquiry.company ? ` — ${enquiry.company}` : ''
            }`,
            text: [
              ...lines.map(([label, value]) => `${label}: ${value}`),
              '',
              'Brief:',
              enquiry.brief,
            ].join('\n'),
          }),
        }).then(async (r) => {
          if (!r.ok) throw new Error(`resend ${r.status}: ${await r.text()}`);
        })
      : Promise.reject(new Error('email not configured')),
  ]);

  // One delivered channel is a success; the enquiry has arrived somewhere.
  if (results.some((r) => r.status === 'fulfilled')) {
    return NextResponse.json({ ok: true });
  }

  for (const result of results) {
    if (result.status === 'rejected' && !/not configured/.test(String(result.reason))) {
      console.error('[contact] delivery failed:', result.reason);
    }
  }

  return NextResponse.json({ ok: false, error: 'delivery-failed' }, { status: 502 });
}
