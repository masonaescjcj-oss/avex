# Supabase, step by step

Everything below is a command you run. Nothing here can be done from this repository on your
behalf: it all needs your project's connection strings and your `supabase login`.

Two values are needed throughout. Get them from **Project Settings → Database**:

- `DIRECT` — the direct connection, port **5432**, host `db.<ref>.supabase.co`
- `POOLED` — the transaction pooler, port **6543**, host `...pooler.supabase.com`

They are not interchangeable, and using the wrong one fails in a way that names nothing in
this codebase. Migrations need `DIRECT` because this schema creates enums and `CREATE TYPE`
through a transaction pooler fails looking like a syntax error in the migration. The request
path needs `POOLED` with prepared statements off, or you get `prepared statement "s1" does not
exist` on the second query.

## 1. Schema

```bash
export DIRECT_DATABASE_URL='postgresql://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres'
npm run -w @avex/api db:migrate
```

Twenty-one migrations. Confirm afterwards:

```bash
psql "$DIRECT_DATABASE_URL" -c '\dt' | wc -l        # ~30 tables
psql "$DIRECT_DATABASE_URL" -c 'select count(*) from assets'
```

## 2. Seed the currency catalogue

`seedCurated()` runs at API startup and is idempotent, so the first boot does it. To do it
ahead of time, run the API once against `DIRECT` locally and stop it — the log says
`curated asset catalogue synchronised` with a count.

## 3. Deploy the API

```bash
npm run -w @avex/api build            # the function imports apps/api/dist
supabase link --project-ref <ref>
supabase functions deploy api --no-verify-jwt
```

Secrets — `supabase secrets set KEY=value`, or `--env-file`:

| Key | Value |
|---|---|
| `DATABASE_URL` | the **pooled** string, port 6543 |
| `DIRECT_DATABASE_URL` | the direct string |
| `APP_URL` | `https://avexpay.net` |
| `DASHBOARD_ORIGINS` | `https://avexpay.net` |
| `CHECKOUT_ORIGINS` | `https://avexpay.net` |
| `MEMO_SECRET` | 32+ random bytes; changing it changes every shared-memo deposit address |
| `CRON_SECRET` | 32+ random bytes, for the scheduler hook |
| `RUN_JOBS_IN_PROCESS` | `false` |
| `FORWARDER_FACTORIES` | `bsc=0x…` once the factory is deployed |
| `SMTP_URL` | `smtps://user:pass@host:465` — **required in production**: without it nothing is emailed and the console transport logs instead |
| `MAIL_FROM` | the address mail comes from, on a domain with SPF and DKIM set up |
| `OPERATOR_EMAIL` | where a critical settlement alert goes — an empty gas wallet, a stuck nonce, a reverted settlement |
| `FORWARDER_IMPLEMENTATIONS` | `chain=address` of the deployed `ForwarderLogic` every deposit address delegates to |
| `FEE_COLLECTORS` | `bsc=0x…` |
| `EVM_RPC_URLS` | `bsc=https://…,https://…` — several, they geofence |

Not here: `SETTLEMENT_KEY_HEX`. Nothing in this process sweeps, so it has no use for a key
that could, and `LocalKeyProvider` refuses to hold one in production anyway.

`DASHBOARD_ORIGINS` is the one people forget. Without it the browser blocks every request
from `avexpay.net` to the function, and the dashboard looks broken with nothing in the API log
— because the request never arrived.

Check it:

```bash
curl -s https://<ref>.supabase.co/functions/v1/api/health
# {"status":"ok"}
curl -si -X OPTIONS https://<ref>.supabase.co/functions/v1/api/v1/organizations \
  -H 'origin: https://avexpay.net' -H 'access-control-request-method: GET' | grep -i access-control
# access-control-allow-origin: https://avexpay.net
```

## 4. The scheduled jobs

Webhook delivery, commission period close and payout changes run on a clock. With
`RUN_JOBS_IN_PROCESS=false` a scheduler drives them.

In the SQL editor, put the two values in the vault first:

```sql
select vault.create_secret('https://<ref>.supabase.co/functions/v1/api', 'avex_api_url');
select vault.create_secret('<CRON_SECRET>', 'avex_cron_secret');
```

Then run `deploy/supabase/cron.sql`. It creates `pg_cron` and `pg_net`, a function that reads
the secret at run time rather than storing it in the job body, and three schedules.

```sql
select * from cron.job;
select * from cron.job_run_details order by start_time desc limit 10;
```

Each job takes its own advisory lock, so a fire landing while the previous run is still going
is a skip rather than a second webhook delivery.

## 5. What still needs a VPS

The chain watcher. It holds a cursor per chain that must advance monotonically and rewinds it
on a reorg; a runtime that scales to zero cannot do that, and two overlapping invocations
would race each other's cursor writes.

```bash
DATABASE_URL="$POOLED" DIRECT_DATABASE_URL="$DIRECT" \
EVM_RPC_URLS='bsc=https://…' FORWARDER_FACTORIES='bsc=0x…' \
FORWARDER_IMPLEMENTATIONS='bsc=0x…' MEMO_SECRET='…' \
npm run -w @avex/api watch
```

It serves no HTTP. A payment it credits reaches a merchant through the webhook rows it writes,
which the scheduler above drains. Until it runs, **no payment is detected** — invoices open
and nothing ever marks them paid.

Sweeping is a separate gap: `SettlementRunner` consumes `ChainSigner` while
`EvmAdapter.settle()` wants `EvmSigner`, and nothing implements the second. Funds stay in the
forwarders until that is built.

## Order, and what breaks if you skip

1. Migrations — nothing works without the schema.
2. Function deployed + `DASHBOARD_ORIGINS` — the dashboard signs in.
3. Cron — webhooks get delivered. Skip it and payments are credited but merchants are
   never told.
4. Watcher on a VPS — payments are detected at all.
5. Forwarder factory + settlement — money actually moves to merchants.

Steps 1–3 are Supabase. Steps 4–5 are not, and step 5 is not built.
