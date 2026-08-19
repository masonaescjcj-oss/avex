import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SUPPORTED_CHAINS } from '@avex/core';

import { SIGNATURE_WINDOW_SECONDS, dashboardLinks, networkCount, signUpWithEmail } from './facts.js';

/**
 * The few facts the site states.
 *
 * Deliberately few: the site names no currencies and quotes no rate, because both belong in
 * the dashboard where they are current by construction. What is left is a count, a window,
 * and the handoff to the panel.
 */

describe('what the site claims about reach', () => {
  test('the network count comes from the product, not from the copy', () => {
    // "Six networks" survives a chain being added or dropped; a typed number does not.
    assert.equal(networkCount(), SUPPORTED_CHAINS.length);
  });

  test('the count is whatever the list holds', () => {
    assert.equal(networkCount(['bsc', 'ton']), 2);
    assert.equal(networkCount([]), 0);
  });

  test('the webhook window is the one the receivers enforce', () => {
    assert.equal(SIGNATURE_WINDOW_SECONDS, 300);
  });
});

describe('handing somebody to the dashboard', () => {
  test('sign in and sign up are the same place, arrived at differently', () => {
    /**
     * The site does not host its own auth form. Two copies is two places for a session bug
     * to live, and the dashboard already has one that is tested.
     */
    const links = dashboardLinks('https://dashboard.avex.example');
    assert.equal(links.signIn, 'https://dashboard.avex.example');
    assert.equal(links.signUp, 'https://dashboard.avex.example?signup=1');
  });

  test('a trailing slash does not become a double one', () => {
    // Otherwise the link is `https://host//?signup=1`, which works and looks broken.
    assert.equal(dashboardLinks('https://d.example/').signIn, 'https://d.example');
    assert.equal(dashboardLinks('https://d.example///').signUp, 'https://d.example?signup=1');
  });

  test('an empty base falls back to a same-origin path', () => {
    // So a deployment that forgets to set it gets a working relative link rather than `?signup=1`
    // resolving against the site root.
    assert.equal(dashboardLinks('').signIn, '/dashboard');
    assert.equal(dashboardLinks('   ').signUp.startsWith('   '), false);
  });

  test('an email is carried across so nobody types it twice', () => {
    const link = signUpWithEmail('https://d.example', 'ali@shop.example');
    assert.equal(link, 'https://d.example?signup=1&email=ali%40shop.example');
  });

  test('an address with characters that need encoding survives', () => {
    // A `+` in a query string means a space. Left unencoded it silently changes the address.
    const link = signUpWithEmail('https://d.example', 'ali+orders@shop.example');
    assert.match(link, /email=ali%2Borders%40shop\.example$/);
  });

  test('an unusable address is dropped rather than passed on', () => {
    /**
     * The dashboard asks for it again, which is the right failure: carrying half an address
     * across would prefill a field with something that cannot be submitted, and the reader
     * would have to work out what is wrong with what they are looking at.
     */
    for (const bad of ['', '   ', 'ali', 'ali@', '@shop.example', 'ali@shop', 'a b@c.example']) {
      assert.equal(signUpWithEmail('https://d.example', bad), 'https://d.example?signup=1');
    }
  });

  test('surrounding whitespace is trimmed, not treated as invalid', () => {
    // Pasting an address out of an email client brings a space with it more often than not.
    assert.match(signUpWithEmail('https://d.example', '  ali@shop.example  '), /email=ali%40shop/);
  });

  test('a dashboard that already has a query keeps it', () => {
    /**
     * The preview build of the panel lives at `?preview=1`, and a deployment could put it
     * behind a tenant parameter. A second `?` does not error — it makes the rest of the query
     * one parameter named `preview=1?signup`, so the page silently ignores everything the
     * site tried to hand it.
     */
    const links = dashboardLinks('https://d.example/panel?preview=1');
    assert.equal(links.signIn, 'https://d.example/panel?preview=1');
    assert.equal(links.signUp, 'https://d.example/panel?preview=1&signup=1');

    const withEmail = signUpWithEmail('https://d.example/panel?preview=1', 'ali@shop.example');
    assert.equal(withEmail, 'https://d.example/panel?preview=1&signup=1&email=ali%40shop.example');
    // One question mark, whatever the base looked like.
    assert.equal(withEmail.split('?').length, 2);
  });
});
