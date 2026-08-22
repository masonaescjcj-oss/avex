import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_CHAINS, chainConfig } from '@avex/core';

import { POOLED_CHAINS } from './schema.js';

/**
 * The one fact this schema states twice.
 *
 * `invoices_chain_deposit_key` is unique on (chain, deposit_address) — the property that stops
 * two invoices claiming one address on chains where the address *is* the invoice's identity.
 * Pooled chains are excluded from it, because there many invoices share each address and the
 * exact amount is what names them.
 *
 * A partial index's predicate must be immutable, so it cannot ask the chain registry which
 * chains are pooled; the list has to be a literal in the index. That is a duplicated fact, and
 * duplicated facts drift. The consequence of drift here is specific and bad in both directions:
 *
 *   - a chain marked pooled in the registry but not excluded from the index fails on its second
 *     invoice, with a unique-constraint violation that names an index rather than the model;
 *   - a chain excluded from the index but not pooled loses the protection silently, and two
 *     invoices can share a derived address with nothing to say which a payment belongs to.
 *
 * So the list is exported and compared here.
 */
const here = dirname(fileURLToPath(import.meta.url));

describe('pooled chains, in the schema and in the registry', () => {
  test('the index predicate names exactly the chains the registry calls pooled', () => {
    const fromRegistry = SUPPORTED_CHAINS.filter(
      (chain) => chainConfig(chain).addressModel === 'pooled',
    );
    assert.deepEqual([...POOLED_CHAINS].sort(), [...fromRegistry].sort());
    assert.ok(fromRegistry.length > 0, 'no pooled chain at all: one of the two sides is wrong');
  });

  test('the generated migration excludes those chains and no others', () => {
    /**
     * Read from the migration rather than from the schema module, because the migration is what
     * the database actually ran. A schema change with no migration generated is the ordinary
     * way this goes wrong, and it leaves the two files disagreeing while every unit test that
     * only imports the schema passes.
     */
    const migrations = join(here, '..', '..', 'migrations');
    const files = readFileSync(join(migrations, 'meta', '_journal.json'), 'utf8');
    const journal = JSON.parse(files) as { entries: { tag: string }[] };

    /** The last migration that touched this index is the one in force. */
    let predicate: string | null = null;
    for (const entry of journal.entries) {
      const sql = readFileSync(join(migrations, `${entry.tag}.sql`), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint')) {
        if (!statement.includes('"invoices_chain_deposit_key"')) continue;
        if (!statement.includes('CREATE UNIQUE INDEX')) continue;
        predicate = statement;
      }
    }
    assert.ok(predicate, 'no migration creates invoices_chain_deposit_key');

    for (const chain of POOLED_CHAINS) {
      assert.ok(
        predicate.includes(`'${chain}'`),
        `${chain} is pooled but the live index does not exclude it`,
      );
    }
    for (const chain of SUPPORTED_CHAINS) {
      if ((POOLED_CHAINS as readonly string[]).includes(chain)) continue;
      assert.ok(
        !predicate.includes(`'${chain}'`),
        `${chain} is not pooled but the index excludes it`,
      );
    }
  });
});
