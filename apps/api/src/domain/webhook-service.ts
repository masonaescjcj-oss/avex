import { WebhookDispatcher, type PendingDelivery } from '@avex/core';
import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import type { Database } from '../db/client.js';
import { webhookDeliveries, webhookEndpoints } from '../db/schema.js';

/**
 * Queues and delivers webhooks.
 *
 * Enqueueing is a database write, never an HTTP call. A merchant's slow endpoint
 * must not delay crediting a payment, and a payment must not fail to be credited
 * because their server is down.
 */
export class WebhookService {
  constructor(
    private readonly db: Database,
    private readonly dispatcher: WebhookDispatcher,
    private readonly log: (message: string) => void = () => {},
  ) {}

  /**
   * Queue an event for every endpoint subscribed to it.
   *
   * `idempotencyKey` defaults to a fresh value, but callers that might enqueue the
   * same event twice — a re-scan, a retried request — should pass a stable one, so
   * the unique constraint collapses the duplicates instead of the merchant seeing
   * both.
   */
  async enqueue(
    organizationId: string,
    event: string,
    payload: Record<string, unknown>,
    idempotencyKey: string = randomUUID(),
  ): Promise<number> {
    const endpoints = await this.db
      .select()
      .from(webhookEndpoints)
      .where(
        and(
          eq(webhookEndpoints.organizationId, organizationId),
          eq(webhookEndpoints.enabled, true),
        ),
      );

    const subscribed = endpoints.filter(
      (endpoint) => endpoint.events.includes(event) || endpoint.events.includes('*'),
    );

    let queued = 0;
    for (const endpoint of subscribed) {
      const inserted = await this.db
        .insert(webhookDeliveries)
        .values({
          endpointId: endpoint.id,
          organizationId,
          event,
          payload,
          idempotencyKey,
        })
        .onConflictDoNothing({
          target: [webhookDeliveries.endpointId, webhookDeliveries.idempotencyKey],
        })
        .returning({ id: webhookDeliveries.id });
      queued += inserted.length;
    }

    return queued;
  }

  /**
   * Attempt every delivery that is due. Run on a timer.
   *
   * Deliveries are taken oldest-first so a backlog drains in the order events
   * happened — a merchant receiving `paid` after `reversed` would act on stale news.
   */
  async drain(now: Date = new Date(), limit = 50): Promise<{
    delivered: number;
    retrying: number;
    failed: number;
    abandoned: number;
  }> {
    const due = await this.db
      .select({
        id: webhookDeliveries.id,
        event: webhookDeliveries.event,
        payload: webhookDeliveries.payload,
        idempotencyKey: webhookDeliveries.idempotencyKey,
        attempts: webhookDeliveries.attempts,
        url: webhookEndpoints.url,
        secret: webhookEndpoints.secret,
        endpointId: webhookEndpoints.id,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(
        and(
          eq(webhookDeliveries.status, 'pending'),
          lte(webhookDeliveries.nextAttemptAt, now),
          eq(webhookEndpoints.enabled, true),
        ),
      )
      .orderBy(asc(webhookDeliveries.createdAt))
      .limit(limit);

    const tally = { delivered: 0, retrying: 0, failed: 0, abandoned: 0 };

    for (const row of due) {
      const delivery: PendingDelivery = {
        id: row.id,
        url: row.url,
        secret: row.secret,
        event: row.event,
        payload: row.payload,
        idempotencyKey: row.idempotencyKey,
        attempts: row.attempts,
      };

      const outcome = await this.dispatcher.deliver(delivery, now.getTime());

      await this.db
        .update(webhookDeliveries)
        .set({
          status: outcome.status,
          attempts: outcome.attempts,
          lastStatusCode: outcome.statusCode,
          lastError: outcome.error,
          nextAttemptAt:
            outcome.nextAttemptAt === null ? now : new Date(outcome.nextAttemptAt),
          deliveredAt: outcome.status === 'delivered' ? now : null,
        })
        .where(eq(webhookDeliveries.id, row.id));

      if (outcome.status === 'delivered') tally.delivered += 1;
      else if (outcome.status === 'pending') tally.retrying += 1;
      else if (outcome.status === 'failed') tally.failed += 1;
      else tally.abandoned += 1;

      if (outcome.status !== 'delivered') {
        this.log(
          `webhook ${row.id} to ${row.url}: ${outcome.status} — ${outcome.error ?? 'no detail'}`,
        );
      }
    }

    return tally;
  }

  /** Re-queue a delivery an operator or merchant wants attempted again. */
  async replay(organizationId: string, deliveryId: string, now: Date = new Date()): Promise<boolean> {
    const updated = await this.db
      .update(webhookDeliveries)
      .set({ status: 'pending', nextAttemptAt: now, attempts: 0, lastError: null })
      .where(
        and(
          eq(webhookDeliveries.id, deliveryId),
          eq(webhookDeliveries.organizationId, organizationId),
        ),
      )
      .returning({ id: webhookDeliveries.id });
    return updated.length > 0;
  }

  /** Delivery history, for the dashboard's webhook log. */
  async history(organizationId: string, limit = 50) {
    const rows = await this.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.organizationId, organizationId))
      .orderBy(asc(webhookDeliveries.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      event: row.event,
      status: row.status,
      attempts: row.attempts,
      lastStatusCode: row.lastStatusCode,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
    }));
  }

  /**
   * Endpoints that have accumulated failures, so an operator can see whose
   * integration is broken before the merchant reports it.
   */
  async unhealthyEndpoints(organizationId?: string) {
    const rows = await this.db
      .select({
        endpointId: webhookDeliveries.endpointId,
        url: webhookEndpoints.url,
        status: webhookDeliveries.status,
        lastError: webhookDeliveries.lastError,
      })
      .from(webhookDeliveries)
      .innerJoin(webhookEndpoints, eq(webhookEndpoints.id, webhookDeliveries.endpointId))
      .where(
        organizationId === undefined
          ? isNull(webhookDeliveries.deliveredAt)
          : and(
              eq(webhookDeliveries.organizationId, organizationId),
              isNull(webhookDeliveries.deliveredAt),
            ),
      );

    const byEndpoint = new Map<string, { url: string; stuck: number; lastError: string | null }>();
    for (const row of rows) {
      if (row.status === 'delivered') continue;
      const entry = byEndpoint.get(row.endpointId) ?? {
        url: row.url,
        stuck: 0,
        lastError: null,
      };
      entry.stuck += 1;
      entry.lastError = row.lastError ?? entry.lastError;
      byEndpoint.set(row.endpointId, entry);
    }

    return [...byEndpoint.entries()].map(([endpointId, entry]) => ({ endpointId, ...entry }));
  }
}
