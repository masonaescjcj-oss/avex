import type { Database } from '../db/client.js';
import { auditLog } from '../db/schema.js';

/**
 * Append-only audit trail.
 *
 * Deliberately exposes only `record`. There is no update and no delete, because
 * the value of this table is entirely in being trustworthy after the fact — and a
 * log that the application can rewrite answers nothing.
 */

export interface AuditActor {
  readonly organizationId?: string | null;
  readonly userId?: string | null;
  readonly apiKeyId?: string | null;
  /** Set when the actor was AVEX staff acting from the admin panel. */
  readonly staffId?: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
}

export interface AuditEntry extends AuditActor {
  /** Dotted past-tense action, e.g. `payout_address.change_requested`. */
  readonly action: string;
  readonly targetType?: string | null;
  readonly targetId?: string | null;
  readonly metadata?: Record<string, unknown> | null;
}

/** Keys whose values must never reach the audit log even if a caller passes them. */
const REDACTED_KEYS = new Set([
  'password',
  'passwordHash',
  'token',
  'tokenHash',
  'secret',
  'totpSecret',
  'apiKey',
  'privateKey',
  'mnemonic',
  'recoveryCode',
]);

/**
 * Strip anything credential-shaped before it is persisted.
 *
 * Callers pass whole request bodies when recording changes, and a single careless
 * spread would otherwise write a plaintext password into a table designed to be
 * kept forever and read during incidents.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key) ? '[redacted]' : redact(nested, depth + 1);
  }
  return out;
}

export class AuditService {
  constructor(private readonly db: Database) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.db.insert(auditLog).values({
      organizationId: entry.organizationId ?? null,
      actorUserId: entry.userId ?? null,
      actorApiKeyId: entry.apiKeyId ?? null,
      actorStaffId: entry.staffId ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      metadata: (redact(entry.metadata ?? null) as Record<string, unknown> | null) ?? null,
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
    });
  }
}
