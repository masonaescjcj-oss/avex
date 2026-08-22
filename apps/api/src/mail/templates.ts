import type { Role } from '../domain/rbac.js';

/**
 * What every transactional message says.
 *
 * Pure functions, in their own file, because the wording is the part of this that a person
 * reads and the part most likely to be changed by somebody who is not thinking about
 * transports. A test can assert what a notice contains without standing up a socket, and both
 * transports send the identical text — the console one in development, SMTP in production.
 */

export interface MailMessage {
  readonly subject: string;
  readonly body: string;
}

/**
 * The link has to land on a page that exists.
 *
 * The dashboard is one page and reads what it should do from its query — `?signup=1` opens the
 * signup form, `?verify=` spends a token — so this points there rather than at a
 * `/verify-email` route nothing serves. It pointed at one for a while, and the effect was that
 * every real signup ended on a 404 with the address left unconfirmed.
 */
export function emailVerification(appUrl: string, token: string): MailMessage {
  return {
    subject: 'Confirm your email address',
    body: `Confirm your email to finish setting up AVEX Pay:\n${appUrl}/dashboard?verify=${encodeURIComponent(token)}`,
  };
}

export function emailAlreadyRegistered(appUrl: string): MailMessage {
  return {
    subject: 'Someone tried to sign up with your email',
    body: `Someone attempted to create an AVEX Pay account with this address. If it was you, sign in instead: ${appUrl}/dashboard`,
  };
}

export function memberInvite(
  appUrl: string,
  email: string,
  details: { organizationName: string; role: Role; token: string; expiresAt: Date },
): MailMessage {
  return {
    subject: `You have been invited to ${details.organizationName} on AVEX Pay`,
    body: [
      `You were invited to join ${details.organizationName} as ${details.role}.`,
      '',
      // Accepting needs an account for this address, so the link says so rather than dropping
      // somebody on a sign-in form with no idea which account to use.
      `Accept it with the account for ${email} — create one if you do not have it yet:`,
      `${appUrl}/dashboard?invite=${encodeURIComponent(details.token)}`,
      '',
      `This invitation expires ${details.expiresAt.toISOString()}.`,
    ].join('\n'),
  };
}

export function membershipRevoked(details: { organizationId: string }): MailMessage {
  return {
    subject: 'Your access to an AVEX Pay organisation was removed',
    body: [
      'Your membership of an organisation on AVEX Pay has been removed, so you no longer',
      'have access to its dashboard.',
      '',
      // The one thing they might reasonably want to check: their own account is intact.
      'Your account itself is unchanged. If this was not expected, speak to whoever runs',
      `that organisation. Reference: ${details.organizationId}`,
    ].join('\n'),
  };
}

export function roleChanged(
  appUrl: string,
  details: { organizationId: string; from: Role; to: Role },
): MailMessage {
  return {
    subject: 'What you can do on AVEX Pay has changed',
    body: [
      `Your role changed from ${details.from} to ${details.to}.`,
      '',
      // Both ends, because "you are now an admin" reads as a promotion either way and the
      // recipient is the person best placed to notice if it was not.
      'If that is not what you expected, speak to whoever runs that organisation.',
      `Reference: ${details.organizationId}`,
      '',
      `${appUrl}/dashboard?tab=team`,
    ].join('\n'),
  };
}

export function payoutChangeQueued(
  appUrl: string,
  details: { chain: string; newAddress: string; effectiveAt: Date },
): MailMessage {
  return {
    subject: 'Payout address change scheduled',
    body: [
      `A change to your ${details.chain} payout address is scheduled.`,
      `New address: ${details.newAddress}`,
      `Takes effect: ${details.effectiveAt.toISOString()}`,
      '',
      'If you did not request this, cancel it now and change your password:',
      // Straight to the tab that cancels it. This notice is the only thing standing between a
      // stolen session and a redirected payout, so it does not get to say "go and find it".
      `${appUrl}/dashboard?tab=payouts`,
    ].join('\n'),
  };
}

/**
 * An operational alert, to whoever is on the hook for the gateway.
 *
 * Unlike everything else in this file, the recipient is us rather than a merchant — and the
 * wording is written for somebody who will read it at three in the morning on a phone. The
 * severity and the kind go in the subject because that is all a notification shows, and the
 * detail carries the figures because a subject nobody can act on wakes somebody for nothing.
 */
export function operatorAlert(
  appUrl: string,
  alert: { readonly severity: string; readonly kind: string; readonly detail: string },
): MailMessage {
  return {
    subject: `[${alert.severity}] AVEX Pay: ${alert.kind.replace(/_/g, ' ')}`,
    body: [
      alert.detail,
      '',
      // What a person will want next, in the order they will want it.
      `Settlements: ${appUrl}/admin?tab=settlements`,
      '',
      'This is sent once per kind per cooldown window, so a condition that persists will not',
      'send again immediately. It is not sent again when it clears, either — check the panel.',
    ].join('\n'),
  };
}
