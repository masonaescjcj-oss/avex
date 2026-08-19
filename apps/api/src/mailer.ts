import type { Role } from './domain/rbac.js';

/**
 * Transactional email.
 *
 * An interface because the transport is a Phase 6 concern, but the seam has to
 * exist now: verification tokens and payout-change notices must leave the process
 * through one place, so they cannot accidentally be returned in an API response.
 */
export interface Mailer {
  sendEmailVerification(email: string, token: string): Promise<void>;
  /**
   * Sent when someone tries to sign up with an address that already has an
   * account. Signup responds identically either way, so this is how the real
   * owner learns about the attempt.
   */
  sendEmailAlreadyRegisteredNotice(email: string): Promise<void>;
  sendMemberInvite(email: string, organizationId: string, role: Role): Promise<void>;
  /**
   * Sent to every member when a payout address change is queued — the delay only
   * protects a merchant who is told about it.
   */
  sendPayoutChangeQueued(
    email: string,
    details: { chain: string; newAddress: string; effectiveAt: Date },
  ): Promise<void>;
}

/** Development transport: records messages and logs them, sends nothing. */
export class ConsoleMailer implements Mailer {
  readonly sent: { to: string; subject: string; body: string }[] = [];

  constructor(
    private readonly appUrl: string,
    private readonly log: (message: string) => void = console.log,
  ) {}

  private record(to: string, subject: string, body: string): void {
    this.sent.push({ to, subject, body });
    this.log(`[mail] to=${to} subject="${subject}"\n${body}`);
  }

  /**
   * The link has to land on a page that exists.
   *
   * The dashboard is one page and reads what it should do from its query — `?signup=1` opens
   * the signup form, `?verify=` spends a token — so this points there rather than at a
   * `/verify-email` route nothing serves. It pointed at one for a while, and the effect was
   * that every real signup ended on a 404 with the address left unconfirmed.
   */
  async sendEmailVerification(email: string, token: string): Promise<void> {
    this.record(
      email,
      'Confirm your email address',
      `Confirm your email to finish setting up AVEX Pay:\n${this.appUrl}/dashboard?verify=${encodeURIComponent(token)}`,
    );
  }

  async sendEmailAlreadyRegisteredNotice(email: string): Promise<void> {
    this.record(
      email,
      'Someone tried to sign up with your email',
      `Someone attempted to create an AVEX Pay account with this address. If it was you, sign in instead: ${this.appUrl}/dashboard`,
    );
  }

  async sendMemberInvite(email: string, organizationId: string, role: Role): Promise<void> {
    this.record(
      email,
      'You have been invited to AVEX Pay',
      `You were invited to join an organisation as ${role}.\n${this.appUrl}/invites?org=${organizationId}`,
    );
  }

  async sendPayoutChangeQueued(
    email: string,
    details: { chain: string; newAddress: string; effectiveAt: Date },
  ): Promise<void> {
    this.record(
      email,
      'Payout address change scheduled',
      [
        `A change to your ${details.chain} payout address is scheduled.`,
        `New address: ${details.newAddress}`,
        `Takes effect: ${details.effectiveAt.toISOString()}`,
        '',
        'If you did not request this, cancel it now and change your password:',
        // Straight to the tab that cancels it. This notice is the only thing standing between
        // a stolen session and a redirected payout, so it does not get to say "go and find it".
        `${this.appUrl}/dashboard?tab=payouts`,
      ].join('\n'),
    );
  }
}
