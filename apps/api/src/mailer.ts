import type { Role } from './domain/rbac.js';
import {
  emailAlreadyRegistered,
  emailVerification,
  memberInvite,
  membershipRevoked,
  payoutChangeQueued,
  roleChanged,
  type MailMessage,
} from './mail/templates.js';
import { sendMail, type SmtpConfig } from './mail/smtp.js';

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
  /**
   * Takes the organisation's *name*, not its id.
   *
   * A person deciding whether to accept needs to recognise who is asking, and a uuid
   * tells them nothing. The token is the only thing in this mail that is a secret.
   */
  sendMemberInvite(
    email: string,
    details: { organizationName: string; role: Role; token: string; expiresAt: Date },
  ): Promise<void>;
  /**
   * Sent to somebody who was removed from an organisation by somebody else.
   *
   * Without it they find out from a 404, which reads as the product being broken
   * rather than as a decision having been made. Not sent when they left of their
   * own accord: nobody needs an email about something they just did.
   */
  sendMembershipRevoked(email: string, details: { organizationId: string }): Promise<void>;
  /** Sent when somebody else changes what a member is allowed to do. */
  sendRoleChanged(
    email: string,
    details: { organizationId: string; from: Role; to: Role },
  ): Promise<void>;
  /**
   * Sent to every member when a payout address change is queued — the delay only
   * protects a merchant who is told about it.
   */
  sendPayoutChangeQueued(
    email: string,
    details: { chain: string; newAddress: string; effectiveAt: Date },
  ): Promise<void>;
}

/**
 * What every transport shares: one composition of every message, and one place to send it.
 *
 * The copy used to live in `ConsoleMailer`, which was fine while that was the only transport.
 * A second one would have meant a second copy of a hundred lines of wording — and the copy
 * that drifts is the one nobody reads, which here would be the one real merchants receive.
 * So a transport now implements `deliver` and inherits every message.
 */
export abstract class ComposedMailer implements Mailer {
  constructor(protected readonly appUrl: string) {}

  protected abstract deliver(to: string, message: MailMessage): Promise<void>;

  async sendEmailVerification(email: string, token: string): Promise<void> {
    await this.deliver(email, emailVerification(this.appUrl, token));
  }

  async sendEmailAlreadyRegisteredNotice(email: string): Promise<void> {
    await this.deliver(email, emailAlreadyRegistered(this.appUrl));
  }

  async sendMemberInvite(
    email: string,
    details: { organizationName: string; role: Role; token: string; expiresAt: Date },
  ): Promise<void> {
    await this.deliver(email, memberInvite(this.appUrl, email, details));
  }

  async sendMembershipRevoked(email: string, details: { organizationId: string }): Promise<void> {
    await this.deliver(email, membershipRevoked(details));
  }

  async sendRoleChanged(
    email: string,
    details: { organizationId: string; from: Role; to: Role },
  ): Promise<void> {
    await this.deliver(email, roleChanged(this.appUrl, details));
  }

  async sendPayoutChangeQueued(
    email: string,
    details: { chain: string; newAddress: string; effectiveAt: Date },
  ): Promise<void> {
    await this.deliver(email, payoutChangeQueued(this.appUrl, details));
  }
}

/** Development transport: records messages and logs them, sends nothing. */
export class ConsoleMailer extends ComposedMailer {
  readonly sent: { to: string; subject: string; body: string }[] = [];

  constructor(
    appUrl: string,
    private readonly log: (message: string) => void = console.log,
  ) {
    super(appUrl);
  }

  protected async deliver(to: string, message: MailMessage): Promise<void> {
    this.sent.push({ to, subject: message.subject, body: message.body });
    this.log(`[mail] to=${to} subject="${message.subject}"\n${message.body}`);
  }
}

/**
 * The real one: one SMTP submission per message.
 *
 * ## Why a failure here does not fail the request
 *
 * Every one of these messages is a notice about something that has already happened — an
 * account was created, an address change was queued, a member was removed. The state is
 * committed before the mail is composed. So a mail server having a bad minute must not turn a
 * successful signup into a 500, which would leave a merchant with an account they were told
 * they did not get.
 *
 * The exception is the one message that is a capability rather than a notice: email
 * verification. A signup whose verification mail never left is an account nobody can confirm,
 * and swallowing that would strand the merchant with no way to tell why. So it is the one
 * failure this class rethrows, and the caller answers honestly.
 *
 * Both are logged either way. A gateway whose notices are silently disappearing is worse than
 * one that never sent them, because the delay on a payout address change is only a protection
 * if somebody was told.
 */
export class SmtpMailer extends ComposedMailer {
  constructor(
    appUrl: string,
    private readonly config: SmtpConfig,
    private readonly from: string,
    private readonly fromName: string,
    private readonly warn: (message: string) => void = console.warn,
  ) {
    super(appUrl);
  }

  override async sendEmailVerification(email: string, token: string): Promise<void> {
    // Rethrown, unlike everything else here: see the note on the class.
    await this.send(email, emailVerification(this.appUrl, token), { rethrow: true });
  }

  protected async deliver(to: string, message: MailMessage): Promise<void> {
    await this.send(to, message, { rethrow: false });
  }

  private async send(
    to: string,
    message: MailMessage,
    options: { readonly rethrow: boolean },
  ): Promise<void> {
    try {
      await sendMail(this.config, {
        from: this.from,
        fromName: this.fromName,
        to,
        subject: message.subject,
        body: message.body,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.warn(`[mail] failed to=${to} subject="${message.subject}" — ${detail}`);
      if (options.rethrow) throw error;
    }
  }
}
