import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { PollOutcome, Watcher } from '@avex/core';

import { DEFAULT_LOOP, runWatchLoop } from './loop.js';

/**
 * The loop that keeps a watcher polling.
 *
 * All of the interesting behaviour is failure behaviour, so the tests are mostly about a
 * watcher that throws. Sleep is injected: a test that waited for real would be slow, and one
 * that mocked timers globally would fight every other async thing in the process.
 */

const outcome = (scannedTo: number): PollOutcome => ({
  chain: 'bsc',
  credited: 0,
  ignored: 0,
  reorg: null,
  reversed: 0,
  scannedTo,
  note: 'test',
});

/** A watcher whose `poll` is whatever the test needs it to be. */
function fakeWatcher(poll: () => Promise<PollOutcome>): Watcher {
  return { poll } as unknown as Watcher;
}

/**
 * A promise plus the function that settles it.
 *
 * Needed because `stop()` takes effect the instant it is called: a test that calls it from
 * its own body sets `running = false` while the first poll is still in flight, so the loop
 * does exactly one pass and exits. Which is correct behaviour, and made the first version of
 * every test below assert against one poll instead of three. So the test waits for the loop
 * to reach the state it is about, and only then stops it.
 */
function gate(): { reached: Promise<void>; reach: () => void } {
  let reach: () => void;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return { reached, reach: reach! };
}

/** Collects the waits instead of performing them. */
function recordedSleeps() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

describe('the watch loop', () => {
  test('polls until it is stopped, then stops', async () => {
    let polls = 0;
    const { sleep } = recordedSleeps();
    const { reached, reach } = gate();

    const handle = runWatchLoop(
      fakeWatcher(async () => {
        polls += 1;
        if (polls >= 3) reach();
        return outcome(polls);
      }),
      DEFAULT_LOOP,
      { sleep },
    );

    await reached;
    await handle.stop();
    assert.ok(polls >= 3, `only ${polls} polls`);
  });

  test('stop waits for the poll in flight rather than abandoning it', async () => {
    /**
     * A poll interrupted between crediting a payment and saving its cursor gets credited
     * again on restart. The sink is idempotent so that survives, but it is noise in the one
     * log that should be quiet — and the fix is one `await`.
     */
    let finished = false;
    let release: (() => void) | null = null;
    const { sleep } = recordedSleeps();

    const handle = runWatchLoop(
      fakeWatcher(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        finished = true;
        return outcome(1);
      }),
      DEFAULT_LOOP,
      { sleep },
    );

    // Let the loop reach the middle of its poll.
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = handle.stop();
    assert.equal(finished, false, 'the poll should still be running');

    release!();
    await stopping;
    assert.equal(finished, true, 'stop returned before the poll completed');
  });

  test('a failing poll does not end the loop', async () => {
    /**
     * The whole reason this file exists. An RPC endpoint that is down, rate limiting us, or
     * lying about the head is the normal weather — a loop that exits on the first 429 stops
     * crediting payments exactly when traffic is highest.
     */
    let attempts = 0;
    const { sleep } = recordedSleeps();
    const { reached, reach } = gate();

    const handle = runWatchLoop(
      fakeWatcher(async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('429 Too Many Requests');
        reach();
        return outcome(attempts);
      }),
      DEFAULT_LOOP,
      { sleep },
    );

    await reached;
    await handle.stop();
    assert.ok(attempts >= 3, 'the loop should have recovered and polled again');
  });

  test('the backoff doubles and then stops doubling', async () => {
    const { waits, sleep } = recordedSleeps();
    const options = { intervalMs: 5_000, backoffMs: 1_000, maxBackoffMs: 8_000 };

    let attempts = 0;
    const { reached, reach } = gate();
    const handle = runWatchLoop(
      fakeWatcher(async () => {
        attempts += 1;
        if (attempts >= 6) reach();
        throw new Error('down');
      }),
      options,
      { sleep },
    );

    await reached;
    await handle.stop();
    // 1s, 2s, 4s, 8s, then capped — bounded because an hour-long outage must not leave the
    // next attempt an hour away, when the chain caught up long ago.
    assert.deepEqual(waits.slice(0, 5), [1_000, 2_000, 4_000, 8_000, 8_000]);
  });

  test('a success resets the backoff', async () => {
    // Otherwise one bad hour makes the rest of the day slow: the counter has to measure
    // consecutive failures, not failures ever.
    const { waits, sleep } = recordedSleeps();
    const options = { intervalMs: 100, backoffMs: 1_000, maxBackoffMs: 60_000 };

    const script = ['fail', 'fail', 'ok', 'fail', 'stop'];
    let index = 0;
    const { reached, reach } = gate();
    const handle = runWatchLoop(
      fakeWatcher(async () => {
        const step = script[index++];
        if (step === 'stop' || step === undefined) {
          reach();
          return outcome(index);
        }
        if (step === 'fail') throw new Error('down');
        return outcome(index);
      }),
      options,
      { sleep },
    );

    await reached;
    await handle.stop();
    // 1s, 2s (two failures), 100ms (the success), then 1s again rather than 4s.
    assert.deepEqual(waits.slice(0, 4), [1_000, 2_000, 100, 1_000]);
  });

  test('every failure is reported, with how many in a row', async () => {
    /**
     * The count is the signal worth alerting on. One failure is weather; forty in a row is
     * an endpoint that is gone, and only the loop knows the difference.
     */
    const seen: number[] = [];
    const { sleep } = recordedSleeps();

    let attempts = 0;
    const { reached, reach } = gate();
    const handle = runWatchLoop(
      fakeWatcher(async () => {
        attempts += 1;
        if (attempts >= 3) reach();
        throw new Error('boom');
      }),
      DEFAULT_LOOP,
      { sleep, onError: (_error, consecutive) => seen.push(consecutive) },
    );

    await reached;
    await handle.stop();
    assert.deepEqual(seen.slice(0, 3), [1, 2, 3]);
  });

  test('a successful poll is reported so a reorg is not silent', async () => {
    // `PollOutcome` carries the reorg and the reversal count, and those are the two things
    // an operator has to be able to see after the fact.
    const outcomes: PollOutcome[] = [];
    const { sleep } = recordedSleeps();

    const { reached, reach } = gate();
    const handle = runWatchLoop(
      fakeWatcher(async () => {
        reach();
        return { ...outcome(500), reorg: { detectedAt: 498, rewoundTo: 434 }, reversed: 2 };
      }),
      DEFAULT_LOOP,
      { sleep, onPoll: (result) => outcomes.push(result) },
    );

    await reached;
    await handle.stop();
    assert.ok(outcomes.length >= 1);
    assert.deepEqual(outcomes[0]!.reorg, { detectedAt: 498, rewoundTo: 434 });
    assert.equal(outcomes[0]!.reversed, 2);
  });

  test('stopping twice is not an error', async () => {
    // Shutdown runs from a signal handler, and a second SIGTERM while the first is still
    // draining is ordinary.
    const { sleep } = recordedSleeps();
    const { reached, reach } = gate();
    const handle = runWatchLoop(
      fakeWatcher(async () => {
        reach();
        return outcome(1);
      }),
      DEFAULT_LOOP,
      { sleep },
    );

    await reached;
    await handle.stop();
    await handle.stop();
  });
});
