'use client';

import { useState } from 'react';
import { services, site } from '@/lib/site';
import styles from './ContactForm.module.css';

const budgets = [
  'Not sure yet',
  'Under $5k',
  '$5k – $15k',
  '$15k – $40k',
  '$40k – $100k',
  '$100k +',
];

const timelines = ['As soon as possible', 'Within a month', 'This quarter', 'Just exploring'];

type Flash = { kind: 'ok' | 'err'; text: string } | null;
type Status = 'idle' | 'sending' | 'sent';

export default function ContactForm() {
  const [form, setForm] = useState({
    name: '',
    company: '',
    contact: '',
    service: services[0].title,
    budget: budgets[0],
    timeline: timelines[0],
    brief: '',
    company_website: '', // honeypot — hidden from people, filled by most bots
  });
  const [flash, setFlash] = useState<Flash>(null);
  const [status, setStatus] = useState<Status>('idle');

  const set = (key: keyof typeof form) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const compose = () =>
    [
      'New project enquiry — retroai.agency',
      '',
      `Name: ${form.name}`,
      form.company ? `Company: ${form.company}` : null,
      `Reach me at: ${form.contact}`,
      `Service: ${form.service}`,
      `Budget: ${form.budget}`,
      `Timeline: ${form.timeline}`,
      '',
      'Brief:',
      form.brief,
    ]
      .filter((line) => line !== null)
      .join('\n');

  const missing = () => {
    const gaps: string[] = [];
    if (!form.name.trim()) gaps.push('your name');
    if (!form.contact.trim()) gaps.push('an email or Telegram handle');
    if (form.brief.trim().length < 12) gaps.push('a sentence about the project');
    return gaps;
  };

  const validate = () => {
    const gaps = missing();
    if (!gaps.length) return true;
    setFlash({
      kind: 'err',
      text: `Still needed: ${gaps.join(', ')}.`,
    });
    return false;
  };

  const submit = async () => {
    if (!validate()) return;
    setStatus('sending');
    setFlash(null);

    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };

      if (data.ok) {
        setStatus('sent');
        setFlash({
          kind: 'ok',
          text: 'Brief received — we reply within one business day.',
        });
        return;
      }

      setStatus('idle');
      // 501 means no delivery channel is configured on this deployment yet.
      setFlash({
        kind: 'err',
        text:
          data.error && data.error !== 'not-configured' && data.error !== 'delivery-failed'
            ? data.error
            : 'Could not send from here. Use Telegram or email below and it reaches us directly.',
      });
    } catch {
      setStatus('idle');
      setFlash({
        kind: 'err',
        text: 'Network error. Use Telegram or email below and it reaches us directly.',
      });
    }
  };

  const mailHref = () => {
    const subject = `Project enquiry — ${form.service}${form.company ? ` — ${form.company}` : ''}`;
    return `mailto:${site.contact.email}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(compose())}`;
  };

  // Telegram cannot pre-fill a direct message, so the brief goes to the
  // clipboard and the chat opens ready for a paste.
  const copyForTelegram = () => {
    navigator.clipboard
      ?.writeText(compose())
      .then(() =>
        setFlash({
          kind: 'ok',
          text: `Brief copied — paste it to ${site.contact.telegramHandle} in the chat that just opened.`,
        }),
      )
      .catch(() =>
        setFlash({
          kind: 'ok',
          text: `Opening Telegram — send your brief to ${site.contact.telegramHandle} there.`,
        }),
      );
  };

  return (
    <form className={styles.form} onSubmit={(e) => e.preventDefault()} noValidate>
      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="name">
            Name <b>*</b>
          </label>
          <input
            id="name"
            className={styles.input}
            value={form.name}
            onChange={set('name')}
            placeholder="Your name"
            autoComplete="name"
            required
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="company">
            Company
          </label>
          <input
            id="company"
            className={styles.input}
            value={form.company}
            onChange={set('company')}
            placeholder="Optional"
            autoComplete="organization"
          />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="contact">
          Email or Telegram <b>*</b>
        </label>
        <input
          id="contact"
          className={styles.input}
          value={form.contact}
          onChange={set('contact')}
          placeholder="you@company.com or @handle"
          required
        />
      </div>

      <div className={styles.row}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="service">
            Service
          </label>
          <select id="service" className={styles.select} value={form.service} onChange={set('service')}>
            {services.map((s) => (
              <option key={s.slug} value={s.title}>
                {s.title}
              </option>
            ))}
            <option value="Not sure / several">Not sure / several</option>
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="budget">
            Budget
          </label>
          <select id="budget" className={styles.select} value={form.budget} onChange={set('budget')}>
            {budgets.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="timeline">
            Timeline
          </label>
          <select
            id="timeline"
            className={styles.select}
            value={form.timeline}
            onChange={set('timeline')}
          >
            {timelines.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.label} htmlFor="brief">
          What are we building? <b>*</b>
        </label>
        <textarea
          id="brief"
          className={styles.textarea}
          value={form.brief}
          onChange={set('brief')}
          placeholder="What breaks today, who feels it, and what a fix would be worth."
          required
        />
      </div>

      <div aria-hidden="true" className={styles.hp}>
        <label htmlFor="company_website">Company website</label>
        <input
          id="company_website"
          name="company_website"
          tabIndex={-1}
          autoComplete="off"
          value={form.company_website}
          onChange={set('company_website')}
        />
      </div>

      {flash && (
        <p
          className={`${styles.flash} ${flash.kind === 'err' ? styles.error : ''}`}
          role="status"
          aria-live="polite"
        >
          {flash.text}
        </p>
      )}

      <div className={styles.actions}>
        <button
          type="submit"
          className="btn btn--solid"
          onClick={submit}
          disabled={status !== 'idle'}
        >
          <span>
            {status === 'sending' ? 'Sending…' : status === 'sent' ? 'Sent' : 'Send brief'}
          </span>
          {status === 'idle' && <span aria-hidden="true">→</span>}
        </button>
        <a
          className="btn btn--ghost"
          href={site.contact.telegram}
          target="_blank"
          rel="noreferrer"
          onClick={copyForTelegram}
        >
          <span>Telegram instead</span>
          <span aria-hidden="true">↗</span>
        </a>
        <a className="btn btn--ghost" href={mailHref()}>
          <span>Email instead</span>
        </a>
      </div>

      <p className={styles.note}>
        Your brief goes straight to us — no tracking, nothing sold on. Reply within one business
        day.
      </p>
    </form>
  );
}
