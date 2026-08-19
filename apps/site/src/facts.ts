import { SUPPORTED_CHAINS } from '@avex/core';

/**
 * The few facts the site states, read from the product rather than transcribed.
 *
 * A marketing page is the one surface nobody tests against reality, so it is the surface
 * where a claim quietly stops being true. There are deliberately very few claims left here:
 * the site does not list which currencies we accept and does not quote a rate — both are
 * things a merchant sees inside the dashboard, where they are current by construction and
 * cannot be a screenshot of last quarter.
 *
 * What remains is a count and a window, and both come from the code that owns them.
 */

/** How many networks a merchant can be paid on. A capability, not a currency list. */
export function networkCount(chains: readonly string[] = SUPPORTED_CHAINS): number {
  return chains.length;
}

/**
 * How long a webhook signature stays valid, mirroring the receivers that enforce it.
 *
 * Quoted in the developer section, where being wrong in either direction is a bug in
 * somebody else's integration: too large and they accept deliveries we reject, too small and
 * they reject ones we consider valid.
 */
export const SIGNATURE_WINDOW_SECONDS = 300;

/**
 * Where the dashboard lives, and how the site hands somebody to it.
 *
 * The site does not host its own sign-in. Two copies of an auth form is two places for a
 * session bug to live, and the dashboard already has one that is tested — so these are
 * links, and the only thing the site contributes is carrying an email across so nobody
 * types it twice.
 */
export function dashboardLinks(base: string): {
  readonly signIn: string;
  readonly signUp: string;
} {
  /**
   * Whitespace first, then the trailing slash.
   *
   * The base arrives from a `<meta>` tag, where a stray newline from a template is ordinary.
   * Left in, it becomes part of the href — the link still resolves, against a path with a
   * space in it, and only the 404 says so.
   */
  const trimmed = base.trim().replace(/\/+$/, '') || '/dashboard';
  return { signIn: trimmed, signUp: withParam(trimmed, 'signup=1') };
}

/**
 * Add one parameter to a URL that may already have a query.
 *
 * The dashboard is not always at a bare path: a preview build carries `?preview=1`, and a
 * deployment could put it behind a tenant parameter. Gluing on a second `?` turns the whole
 * query into one unreadable parameter, and the failure is silent — the link still opens, on
 * a page that ignores everything the site tried to tell it.
 */
function withParam(url: string, param: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}${param}`;
}

/**
 * The sign-up link for a given email, or the plain one when it is not usable.
 *
 * Deliberately permissive about what an address looks like — one `@` with something either
 * side. A stricter test rejects real addresses, and the cost of being wrong here is only
 * that the dashboard asks for the address again rather than pre-filling it.
 */
export function signUpWithEmail(base: string, email: string): string {
  const { signUp } = dashboardLinks(base);
  const trimmed = email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return signUp;
  return withParam(signUp, `email=${encodeURIComponent(trimmed)}`);
}
