# RetroAI — retroai.agency

The RetroAI agency website. Next.js 15 App Router, TypeScript, CSS Modules, zero runtime
dependencies beyond React — every route prerenders to static HTML.

**Stack:** Next.js 15 · React 19 · TypeScript · CSS Modules · `next/font` (Space Grotesk +
JetBrains Mono, self-hosted at build time) · `next/og` for the social image.

## Local development

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build
npm run typecheck  # tsc --noEmit
```

## Deploying to Vercel

The repository is Vercel-ready with no configuration needed beyond the defaults:

1. Import the repository at [vercel.com/new](https://vercel.com/new).
2. Framework preset is detected as **Next.js** — leave the build and output settings alone.
3. Add `retroai.agency` (and `www.retroai.agency`) under **Settings → Domains**.
4. Add the contact-form variables below under **Settings → Environment Variables**.
5. Deploy.

The site deploys and works with no environment variables at all — the contact
form then falls back to opening Telegram or the visitor's mail client.

### Contact form delivery

`app/api/contact/route.ts` is a serverless Route Handler: no server to run, and
the credentials stay server-side where a browser cannot read them. Configure at
least one channel (see `.env.example`).

**Telegram** — recommended, since enquiries land in the same place you already
answer from:

1. Message [@BotFather](https://t.me/BotFather), send `/newbot`, copy the token.
2. Send your new bot any message, open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy
   `result[0].message.chat.id`.
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

To post into a channel instead, add the bot as an admin of the channel and use
the channel id (`-100…`) as `TELEGRAM_CHAT_ID`.

**Email** — optional, via [Resend](https://resend.com) (3,000/month free). Set
`RESEND_API_KEY`, `CONTACT_EMAIL_TO` and `CONTACT_EMAIL_FROM`; the from-address
domain must be verified with Resend. With both configured, each enquiry is sent
to Telegram and email, and one delivered channel counts as success.

The endpoint validates and length-caps every field, carries a honeypot, and
throttles repeat submissions per IP. That throttle is best-effort: serverless
instances are ephemeral and there may be several at once, so it trims casual
repeats rather than guaranteeing a limit. If spam ever becomes a real problem,
add Turnstile or hCaptcha in front of it.

`vercel.json` pins the framework and enables clean URLs. Security headers are set in
`next.config.mjs`.

## Structure

```
app/
  layout.tsx            root layout, fonts, metadata, Organization JSON-LD
  page.tsx              home
  globals.css           design tokens and shared classes
  home.module.css       homepage-only sections (receipt, stats, rows)
  inner.module.css      shared inner-page styles (blocks, cards, rows, metrics)
  services/             the four disciplines + engagement models
  work/                 index + [slug] case studies (static params)
  process/              five-phase delivery process
  about/                studio, team, timeline, principles
  blog/                 index + [slug] posts (static params)
  careers/              open roles
  contact/              brief form + direct channels + FAQ
  api/contact/          POST endpoint that forwards a brief to Telegram / email
  status/               fleet status (noindex)
  not-found.tsx         404
  sitemap.ts robots.ts opengraph-image.tsx icon.svg
components/
  Nav Footer Hero CTA Marquee Reveal Counter Clock ContactForm Receipt
  demos/Demos.tsx       the four scroll-driven service demos
lib/hooks.ts            useInView, useSteps, useScrollProgress, useReducedMotion
lib/
  site.ts               brand, contact details, nav, services, stack, stats
  content.ts            projects, posts, roles, process steps, fleet
```

## Editing content

All copy that repeats across pages lives in `lib/site.ts` and `lib/content.ts`. Changing the
contact details, adding a service, a case study, a journal post or a job opening means editing
one array — pages, the sitemap and the footer pick it up automatically.

## Notes

- **Contact form** posts to `/api/contact`, which forwards the brief to Telegram and/or email.
  Nothing is stored and there is no tracking. If neither channel is configured — or delivery
  fails — the form says so and the Telegram and email buttons still work, so an enquiry is never
  silently lost.
- **Accessibility:** skip link, visible focus rings, `prefers-reduced-motion` honoured throughout
  (reveals, counters, marquee and terminal all fall back to their finished state).
- **Design:** dark retro-terminal system — near-black `#06060a`, amber `#ffb020`, cyan `#37e6c8`,
  with a subtle CRT scanline overlay. Tokens are at the top of `app/globals.css`.
