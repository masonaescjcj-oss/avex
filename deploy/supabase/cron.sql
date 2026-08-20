-- Scheduled jobs, for a deployment with no long-lived process.
--
-- Applied by hand, not by Drizzle. Two migration tools pointed at one database is how a
-- journal diverges from reality, and this file is about the *host*, not the schema: nothing
-- here is part of the application's data model, and a self-hosted deployment that runs the
-- API as a service does not want it at all.
--
-- The three jobs are the same ones a server runs on timers. Each takes its own Postgres
-- advisory lock inside the application, so a schedule firing while the previous run is still
-- going is a skip rather than a second webhook delivery.
--
-- Requires: `pg_cron` and `pg_net`, both available on Supabase.
--   pg_cron runs the schedule; pg_net makes the HTTP call without blocking the scheduler.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The secret and the URL, kept out of the schedule body.
--
-- `cron.schedule` stores its command as text in a table any superuser can read, and a
-- secret pasted into it would sit there for the life of the deployment. Vault keeps it out
-- of the job definition; the job asks for it by name at run time.
--
-- Set these once, from a session you trust:
--   select vault.create_secret('https://<project>.supabase.co/functions/v1/api', 'avex_api_url');
--   select vault.create_secret('<CRON_SECRET>', 'avex_cron_secret');

create or replace function avex_run_job(job text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  base text;
  secret text;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'avex_api_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'avex_cron_secret';

  -- Refuse loudly rather than post to nowhere. A silently failing scheduler means webhooks
  -- stop being delivered and nothing anywhere says why.
  if base is null or secret is null then
    raise exception 'avex_run_job: avex_api_url or avex_cron_secret is not in the vault';
  end if;

  return net.http_post(
    url := base || '/internal/jobs?job=' || job,
    headers := jsonb_build_object('x-cron-secret', secret, 'content-type', 'application/json'),
    body := '{}'::jsonb,
    -- Longer than a webhook drain takes, shorter than the gap between fires. A request that
    -- outlives its own schedule is one the next fire will skip anyway, thanks to the lock.
    timeout_milliseconds := 20000
  );
end;
$$;

-- The intervals mirror `jobInterval()` in apps/api/src/jobs.ts. pg_cron's finest grain is a
-- minute, so webhook delivery runs every minute rather than every ten seconds: a payment
-- notification arriving up to a minute late is a latency change, not a correctness one, and
-- the retry schedule already assumes delivery is not instant.
select cron.schedule('avex-webhooks',   '* * * * *',  $$select avex_run_job('webhooks')$$);
select cron.schedule('avex-payouts',    '* * * * *',  $$select avex_run_job('payouts')$$);
select cron.schedule('avex-commission', '0 * * * *',  $$select avex_run_job('commission')$$);

-- To inspect:  select * from cron.job;
--              select * from cron.job_run_details order by start_time desc limit 20;
-- To remove:   select cron.unschedule('avex-webhooks');
