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

export default function ContactForm() {
  const [form, setForm] = useState({
    name: '',
    company: '',
    contact: '',
    service: services[0].title,
    budget: budgets[0],
    timeline: timelines[0],
    brief: '',
  });
  const [flash, setFlash] = useState<Flash>(null);

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

  const validate = () => {
    if (!form.name.trim() || !form.contact.trim() || form.brief.trim().length < 12) {
      setFlash({
        kind: 'err',
        text: 'Add your name, a way to reach you, and a sentence or two about the project.',
      });
      return false;
    }
    return true;
  };

  const sendEmail = () => {
    if (!validate()) return;
    const subject = `Project enquiry — ${form.service}${form.company ? ` — ${form.company}` : ''}`;
    window.location.href = `mailto:${site.contact.email}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(compose())}`;
    setFlash({ kind: 'ok', text: 'Your mail client should be opening with the brief attached.' });
  };

  const sendTelegram = async () => {
    if (!validate()) return;
    // Telegram cannot pre-fill a direct message, so the brief goes to the
    // clipboard and the chat opens ready for a paste.
    try {
      await navigator.clipboard.writeText(compose());
      setFlash({ kind: 'ok', text: 'Brief copied — paste it into the chat that just opened.' });
    } catch {
      setFlash({ kind: 'ok', text: 'Telegram is opening. Paste or retype your brief there.' });
    }
    window.open(site.contact.telegram, '_blank', 'noopener,noreferrer');
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
        <button type="button" className="btn btn--solid" onClick={sendTelegram}>
          <span>Send on Telegram</span>
          <span aria-hidden="true">↗</span>
        </button>
        <button type="button" className="btn" onClick={sendEmail}>
          <span>Send by email</span>
        </button>
      </div>

      <p className={styles.note}>
        No database, no tracking — the form only assembles your brief and hands it to Telegram or
        your mail client. Reply within one business day.
      </p>
    </form>
  );
}
