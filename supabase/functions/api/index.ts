/**
 * The AVEX Pay API, as a Supabase Edge Function.
 *
 * Deno, request-scoped, no port to listen on. Fastify does not need one: `app.inject()` is
 * its own in-process request path — the same one every integration test in this repository
 * goes through — so this file is an adapter between a web `Request` and that, and nothing
 * else. There is no second copy of the routing, the middleware or the service graph;
 * `compose()` builds the identical object `main.ts` builds.
 *
 * What is deliberately absent:
 *
 *   - `seedCurated()`. It is idempotent, but it reads every curated asset on every cold
 *     start, and an isolate can start often. The catalogue is seeded once by a deploy step.
 *   - The price tick writer. It buffers and flushes on a timer, and a timer in an isolate
 *     that is frozen between requests either never fires or fires against a pool that has
 *     gone. Ticks are diagnostics, not money.
 *   - The settlement signers. This process cannot sweep funds — see docs/DEPLOY.md — so it
 *     has no reason to hold a key that could.
 *   - The job timers. A scheduler calls `POST /internal/jobs` instead; `RUN_JOBS_IN_PROCESS`
 *     must be `false` here, or nothing would run them and nothing would say so.
 */

import process from 'node:process';

import { compose } from '../../../apps/api/dist/compose.js';
import { createDatabase } from '../../../apps/api/dist/db/client.js';
import { loadEnv } from '../../../apps/api/dist/env.js';

/**
 * Built once per isolate, not once per request.
 *
 * Isolates are reused between requests, so this is where connection reuse comes from — a
 * pool per request would open a connection per request, which is the thing a pooler exists
 * to prevent. Held as a promise so two requests arriving during the same cold start share
 * one build instead of racing to make two pools.
 */
let booting: Promise<{ app: Awaited<ReturnType<typeof build>>['app'] }> | null = null;

async function build() {
  /**
   * `Deno.env.toObject()`, because `loadEnv` reads a plain object.
   *
   * Not `process.env`: the Node compatibility shim populates it lazily and misses secrets
   * set after the isolate started, which produces a validation error naming a variable the
   * dashboard clearly shows as set.
   */
  const source = Deno.env.toObject() as unknown as NodeJS.ProcessEnv;
  const env = loadEnv(source);

  const { db } = createDatabase(env.DATABASE_URL, { prepare: env.DATABASE_PREPARE, max: 2 });
  const { app } = compose({ env, db });
  await app.ready();
  return { app };
}

function boot() {
  booting ??= build();
  return booting;
}

Deno.serve(async (request: Request) => {
  const { app } = await boot();
  const url = new URL(request.url);

  /**
   * Supabase mounts a function at `/functions/v1/<name>`, and the app's routes do not know
   * about that prefix. Stripped here rather than duplicated into every route, because a
   * route table that carries its host's mount point stops being portable.
   */
  const path = url.pathname.replace(/^\/functions\/v1\/api/, '') || '/';

  const response = await app.inject({
    method: request.method as 'GET',
    url: path + url.search,
    headers: Object.fromEntries(request.headers),
    // `undefined`, not an empty string: light-my-request sets a content-length of 0 for a
    // body it was given, and a GET with `content-length: 0` is refused by some proxies.
    payload: request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : await request.text(),
  });

  return new Response(response.rawPayload, {
    status: response.statusCode,
    headers: response.headers as Record<string, string>,
  });
});

// Referenced so the Node shim is loaded before `loadEnv` touches its default parameter.
void process;
