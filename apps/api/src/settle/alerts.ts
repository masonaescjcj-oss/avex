import type { Alert } from '@avex/core';

import type { Mailer } from '../mailer.js';

/**
 * Getting an alert to a person.
 *
 * `SettlementRunner` raises four things worth waking somebody for — a gas wallet that cannot
 * cover a settlement, a transaction stuck behind a nonce, the hourly spend cap reached, and a
 * settlement that reverted — and buffers them for whoever drains `takeAlerts()`. Nothing did.
 * They reached the log, which is only an alert if somebody is looking at the log.
 *
 * ## Why the throttle is the whole design
 *
 * Every one of these conditions persists. A gas wallet that is empty is empty on the next pass
 * too, and a stuck transaction is stuck until it is replaced — so a forwarder without a cooldown
 * sends a message every thirty seconds until somebody either fixes it or stops reading. The
 * second is what actually happens, and then the next alert is missed.
 *
 * So one message per kind per window. Keyed on the kind and not the detail, deliberately: a
 * stuck-transaction alert says how many seconds it has been stuck, so a key that included the
 * text would be a new key every pass and the throttle would do nothing at all.
 *
 * ## What is emailed, and what only logged
 *
 * Critical only. A warning is a number moving in the wrong direction — the spend cap reached, a
 * wallet with fewer than fifty settlements of runway — and it belongs in a log and a dashboard. A
 * critical is money already stopped: nothing is settling, or a settlement burned gas and moved
 * nothing. Emailing both trains somebody to filter the folder.
 */

/** Fifteen minutes. Long enough not to be noise, short enough that a fix gets confirmed. */
export const DEFAULT_ALERT_COOLDOWN_MS = 15 * 60_000;

export class AlertForwarder {
  private readonly lastSentAt = new Map<string, number>();

  constructor(
    private readonly mailer: Mailer,
    /** Where alerts go. Undefined means logging only, which is said at startup. */
    private readonly to: string | undefined,
    private readonly log: (message: string, data?: unknown) => void = () => {},
    private readonly cooldownMs: number = DEFAULT_ALERT_COOLDOWN_MS,
  ) {}

  /**
   * Log every alert, email the critical ones, and never throw.
   *
   * Called from inside a settlement pass, so a mail server having a bad minute must not fail the
   * pass — the alert would then be about the alerting rather than about the money. A failed send
   * is logged and the cooldown is *not* recorded, so the next pass tries again.
   */
  async forward(alerts: readonly Alert[], now: number = Date.now()): Promise<void> {
    for (const alert of alerts) {
      this.log(`alert: ${alert.kind}`, { severity: alert.severity, detail: alert.detail });

      if (alert.severity !== 'critical') continue;
      if (this.to === undefined) continue;

      const last = this.lastSentAt.get(alert.kind);
      if (last !== undefined && now - last < this.cooldownMs) continue;

      try {
        await this.mailer.sendOperatorAlert(this.to, alert);
        this.lastSentAt.set(alert.kind, now);
      } catch (error) {
        this.log('alert could not be emailed', {
          kind: alert.kind,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
