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
4. Deploy. No environment variables are required.

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
  status/               fleet status (noindex)
  not-found.tsx         404
  sitemap.ts robots.ts opengraph-image.tsx icon.svg
components/
  Nav Footer Hero CTA Terminal Marquee Reveal Counter Clock ContactForm
lib/
  site.ts               brand, contact details, nav, services, stack, stats
  content.ts            projects, posts, roles, process steps, fleet
```

## Editing content

All copy that repeats across pages lives in `lib/site.ts` and `lib/content.ts`. Changing the
contact details, adding a service, a case study, a journal post or a job opening means editing
one array — pages, the sitemap and the footer pick it up automatically.

## Notes

- **Contact form** has no backend by design. It assembles the brief and hands it to Telegram
  (copied to the clipboard, chat opened) or to the visitor's mail client via `mailto:`. Nothing is
  stored and there is no tracking. Wire it to an email API later if a server-side inbox is wanted.
- **Accessibility:** skip link, visible focus rings, `prefers-reduced-motion` honoured throughout
  (reveals, counters, marquee and terminal all fall back to their finished state).
- **Design:** dark retro-terminal system — near-black `#06060a`, amber `#ffb020`, cyan `#37e6c8`,
  with a subtle CRT scanline overlay. Tokens are at the top of `app/globals.css`.
