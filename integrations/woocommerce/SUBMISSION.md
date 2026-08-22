# Submitting to the WordPress plugin directory

What the directory requires, what this plugin already satisfies, and the five things nobody but
the operator can do. Written down because the first review is by a human, takes days to weeks,
and a rejection costs another round of it.

## How it works, in outline

1. A WordPress.org account. The plugin is submitted under it and the account name becomes a
   `Contributors:` entry in `readme.txt`.
2. Upload a **ZIP** at https://wordpress.org/plugins/developers/add/. The top-level folder inside
   it must be the slug — `avex-pay-for-woocommerce`.
3. A reviewer reads the code. They are looking for the things in the checklist below, and they
   will install it and click the links in the readme.
4. On approval you get an **SVN** repository, not git. Publishing is `svn cp trunk tags/1.0.0`.
   The git history in this repository is for us; the directory only ever sees what is committed
   to SVN.
5. Icons, banners and screenshots go in the SVN `/assets` folder — **not** in the plugin ZIP.

## Building what gets uploaded

```
npm run plugin:zip      # integrations/woocommerce/dist/avex-pay-for-woocommerce-1.0.0.zip
npm run plugin:assets   # integrations/woocommerce/assets/*.png
```

`plugin:zip` checks before it builds, and refuses rather than producing a ZIP that would be
rejected: the header `Version` against the readme's `Stable tag`, the text domain against the
slug, the headers the directory requires, the `== External services ==` section, an `ABSPATH`
guard on every PHP file that ships, and no leftover debug output. Each of those is a rejection
that costs another wait in the review queue, so it costs a second here instead.

`tests/` is not in the ZIP. `run-tests.php` is a CLI runner with no `ABSPATH` guard — correct for
what it is, and a file anybody could execute by URL once it is inside a plugin directory. The fix
is not to guard a test runner, it is not to ship it.

`plugin:assets` draws the icon and banner from the mark in the receipt template. They belong in
SVN `/assets` after approval, **not** in the ZIP.

## What the directory requires, and where this plugin stands

| Requirement | State |
|---|---|
| GPL-compatible licence | MIT, which is compatible. `License` and `License URI` are in both the plugin header and the readme. |
| Slug is not somebody else's trademark | `avex-pay-for-woocommerce`. "for WooCommerce" as a suffix is the accepted form; starting the slug with `woocommerce-` is not. |
| Text domain matches the slug | Yes. It was `avex-pay` and would have been rejected. |
| No obfuscated or minified code without source | No build step; every file is the source. |
| No executable code fetched from a remote server | The plugin calls a JSON API and never loads code. |
| Sanitise, escape, validate | Settings go through WooCommerce's own settings API, which handles nonces and sanitising. The webhook body is read raw — correct for a signature — and verified with `hash_equals` before anything is written. |
| Unique prefixes | `Avex_` on classes, `avex_pay` for the gateway id, `AVEX_PAY_` for constants. |
| No tracking without consent | Nothing is collected. No analytics, no phone-home, no admin notices. |
| External services disclosed | `== External services ==` in `readme.txt`, naming every endpoint, what is sent, and — the part reviewers look for — that **no customer data leaves the store**. |
| A complete, working plugin | 1,384 lines, 44 tests (`npm run test:plugin`). |
| `readme.txt` in the required format | Headers, `Stable tag`, description, installation, FAQ, changelog. |

## The five things only the operator can do

1. **A WordPress.org account**, and its username in `Contributors:`. It currently says `avex`,
   which is a placeholder unless that account exists and is yours.

2. **`Tested up to:` must be a WordPress version you have actually run this on.** It says 6.7,
   which was current when the plugin was written and is now stale — the directory wants a value
   within the last couple of releases, and a stale one is a common rejection. Install the current
   WordPress, run a real order through the plugin, and put *that* version in. Do not raise the
   number without testing: it is a claim about testing, and it is the one claim in the readme
   that somebody could check against a bug report.

3. **`https://avexpay.net/terms` and `https://avexpay.net/privacy` have to exist.** The
   external-services disclosure links to them and a reviewer will click. They are legal
   documents about a real company's obligations, so they are not something to generate — but
   without them the disclosure is incomplete and the submission fails on it.

4. **Screenshots.** The icon and banner are generated — `npm run plugin:assets` writes
   `icon-128x128.png`, `icon-256x256.png`, `banner-772x250.png` and `banner-1544x500.png` into
   `assets/`, and they are committed. Screenshots are the part that cannot be: two or three of
   the settings page and a real checkout, taken from a WooCommerce install. Optional in the rules
   and effectively required in practice — a plugin page with no screenshots reads as untested.

5. **The API base default.** It ships as `https://api.avexpay.net`, which does not resolve yet.
   A reviewer testing the plugin will get a connection error and may read that as a broken
   plugin, so point it at the deployed API before submitting — see `docs/GO-LIVE.md`.

## Things worth knowing before the first review

**Requiring an external account is allowed.** A plugin that is a client for a paid service is
fine, as long as the service is disclosed and the plugin is not a stub whose only function is to
advertise it. This one does the whole integration.

**The review is of the code, not of the business.** Reviewers do not assess whether a payment
gateway is a good idea. What they reject is unsanitised input, remote code, undisclosed data
collection, trademark misuse in the slug, and readmes that promise features the code does not
have.

**Version bumps are cheap, rejections are not.** After approval, publishing an update is an SVN
tag. Before approval, every fix means waiting in the queue again — which is why the checklist
above is worth clearing in one pass.

**The plugin does not need to be in the directory to be used.** A ZIP installed by hand works
identically. The directory buys discovery and one-click updates, and nothing else.
