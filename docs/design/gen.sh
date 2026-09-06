#!/usr/bin/env bash
# Regenerates the AVEX Pay design artboards. Every screen is drawn from the real
# product: the fields the API actually accepts, the tabs the dashboard actually
# has, and packages/design/tokens.css for every colour.
set -euo pipefail
cd "$(dirname "$0")"

L='--n0:#ffffff;--n50:#f7f8f9;--n100:#eef0f2;--n200:#e3e6ea;--n300:#cfd4da;--n400:#a6adb7;--n500:#6b7480;--n600:#5b6370;--n700:#414853;--n900:#1a1d22;--lime:#c8f135;--lime-ink:#1a2400;--accent:#5f7a00;--accent-soft:#eef7c9;--accent-edge:#b9d95a;--ok:#0f7a4f;--ok-soft:#e3f5ec;--warn:#9a5b00;--warn-soft:#fff1d6;--danger:#b42318;--danger-soft:#fde8e6;--info:#175cd3;--info-soft:#e6effc;--bg:#f7f8f9;--surface:#ffffff;--surface-2:#f7f8f9;--surface-3:#eef0f2;--line:#e3e6ea;--line-strong:#cfd4da;--ink:#1a1d22;--ink-2:#414853;--muted:#5b6370;--faint:#6b7480'

D='--lime:#c8f135;--lime-ink:#1a2400;--accent:#c8f135;--accent-soft:#232b0f;--accent-edge:#3e4d10;--ok:#4ade80;--ok-soft:#0f2a1c;--warn:#fbbf24;--warn-soft:#2d2208;--danger:#f87171;--danger-soft:#2f1412;--info:#60a5fa;--info-soft:#0f1e33;--bg:#0c0e11;--surface:#14171c;--surface-2:#1a1e24;--surface-3:#22272f;--line:#262c35;--line-strong:#343b46;--ink:#f2f4f6;--ink-2:#c9cfd7;--muted:#a3abb6;--faint:#7d8591'

F='font-family:ui-sans-serif,-apple-system,Inter,Roboto,Arial,sans-serif'
M='font-family:ui-monospace,Menlo,Consolas,monospace'
FRAME='width:390px;height:844px;overflow:hidden;display:flex;flex-direction:column;box-sizing:border-box;background:var(--bg);color:var(--ink);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased'
CARD='background:var(--surface);border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 2px rgba(16,24,40,0.05)'
BTN='width:100%;box-sizing:border-box;height:48px;border:0;border-radius:10px;background:var(--lime);color:var(--lime-ink);font-size:15px;font-weight:600;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px'
GHOST='width:100%;box-sizing:border-box;height:48px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface);color:var(--ink);font-size:15px;font-weight:550;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:8px'
FIELD='display:flex;align-items:center;gap:10px;height:48px;padding:0 14px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface);box-sizing:border-box'
FIELDON='display:flex;align-items:center;gap:10px;height:48px;padding:0 14px;border:1px solid var(--accent-edge);border-radius:10px;background:var(--surface);box-sizing:border-box;box-shadow:0 0 0 3px rgba(95,122,0,0.18)'
LAB='display:block;font-size:13px;font-weight:550;color:var(--ink-2);margin-bottom:6px'
SVG='width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
SVGN='width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'

top() { cat <<HEAD
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
HEAD
}
tail_() { cat <<TAIL
</x-dc>
</body>
</html>
TAIL
}

# ── the AVEX mark, used on every auth screen ─────────────────────────────────
mark() { cat <<MARK
<div style="display:flex;align-items:center;gap:10px;">
  <div style="width:36px;height:36px;border-radius:11px;background:var(--lime);color:var(--lime-ink);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:19px;letter-spacing:-0.02em;">A</div>
  <span style="font-weight:600;font-size:17px;letter-spacing:-0.015em;">AVEX Pay</span>
</div>
MARK
}

# ═══ 1. Sign in ══════════════════════════════════════════════════════════════
{ top; cat <<EOF
<div style="$L;$F;$FRAME">
  <div style="padding:56px 24px 0;">
    $(mark)
  </div>
  <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 24px 44px;">
    <h1 style="margin:0 0 6px;font-size:30px;line-height:1.15;font-weight:650;letter-spacing:-0.022em;">Sign in</h1>
    <p style="margin:0 0 30px;color:var(--muted);">To your merchant dashboard.</p>

    <label style="display:block;margin-bottom:16px;">
      <span style="$LAB">Email</span>
      <div style="$FIELD">
        <svg $SVG style="color:var(--faint);flex:none;"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>
        <span>kian@kianshop.ir</span>
      </div>
    </label>

    <label style="display:block;margin-bottom:10px;">
      <span style="$LAB">Password</span>
      <div style="$FIELDON">
        <svg $SVG style="color:var(--faint);flex:none;"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>
        <span style="flex:1;letter-spacing:0.18em;color:var(--ink-2);">••••••••••••</span>
        <svg $SVG style="color:var(--faint);flex:none;"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.75"/></svg>
      </div>
    </label>
    <p style="margin:0 0 26px;font-size:13px;color:var(--faint);">At least 10 characters — the only rule we set.</p>

    <button style="$BTN">Sign in</button>

    <div style="display:flex;align-items:center;gap:9px;margin:22px 0 0;color:var(--muted);font-size:13px;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>
      <span>We ask for your authenticator code next.</span>
    </div>
  </div>

  <div style="padding:0 24px 34px;text-align:center;color:var(--muted);font-size:14px;">
    New here? <span style="color:var(--accent);font-weight:600;">Create a merchant account</span>
  </div>
</div>
EOF
tail_; } > Main.dc.html

# ═══ 2. Authenticator code ═══════════════════════════════════════════════════
{ top; cat <<EOF
<div style="$L;$F;$FRAME">
  <div style="flex:1;padding:22px 24px 0;">
    <div style="width:44px;height:44px;margin-left:-10px;display:flex;align-items:center;justify-content:center;color:var(--ink-2);">
      <svg $SVGN><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>
    </div>

    <h1 style="margin:26px 0 8px;font-size:28px;line-height:1.2;font-weight:650;letter-spacing:-0.02em;">Enter your code</h1>
    <p style="margin:0 0 30px;color:var(--muted);">Open your authenticator app and type the six digits shown for <span style="color:var(--ink-2);font-weight:550;">AVEX Pay</span>.</p>

    <div style="display:flex;gap:9px;">
      <div style="flex:1;height:60px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;">4</div>
      <div style="flex:1;height:60px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;">0</div>
      <div style="flex:1;height:60px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;">2</div>
      <div style="flex:1;height:60px;border:1px solid var(--accent-edge);border-radius:12px;background:var(--surface);box-shadow:0 0 0 3px rgba(95,122,0,0.18);display:flex;align-items:center;justify-content:center;">
        <div style="width:2px;height:26px;background:var(--accent);border-radius:2px;"></div>
      </div>
      <div style="flex:1;height:60px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);"></div>
      <div style="flex:1;height:60px;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);"></div>
    </div>

    <div style="display:flex;align-items:center;gap:8px;margin-top:16px;color:var(--muted);font-size:13px;">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/></svg>
      <span>The code changes every 30 seconds.</span>
    </div>

    <div style="margin-top:28px;"><button style="$BTN">Verify and continue</button></div>

    <div style="margin-top:14px;"><button style="$GHOST">Use a recovery code</button></div>
  </div>

  <div style="padding:0 24px 34px;">
    <div style="display:flex;gap:11px;padding:13px 14px;border-radius:12px;background:var(--surface-3);color:var(--muted);font-size:13px;line-height:1.45;">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:1px;"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/></svg>
      <span>Lost the phone with your authenticator? A recovery code is the only way back in — we cannot reset the secret for you.</span>
    </div>
  </div>
</div>
EOF
tail_; } > Authenticator.dc.html

# ═══ 3. Create account ═══════════════════════════════════════════════════════
{ top; cat <<EOF
<div style="$L;$F;$FRAME">
  <div style="padding:52px 24px 0;">
    $(mark)
  </div>
  <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 24px 40px;">
    <h1 style="margin:0 0 6px;font-size:28px;line-height:1.18;font-weight:650;letter-spacing:-0.022em;">Create your account</h1>
    <p style="margin:0 0 26px;color:var(--muted);">Two minutes. No documents, no card.</p>

    <label style="display:block;margin-bottom:14px;">
      <span style="$LAB">Business name</span>
      <div style="$FIELD">
        <svg $SVG style="color:var(--faint);flex:none;"><path d="M4 20V9l8-5 8 5v11"/><path d="M9.5 20v-5h5v5"/></svg>
        <span>Kian Shop</span>
      </div>
    </label>

    <label style="display:block;margin-bottom:14px;">
      <span style="$LAB">Email</span>
      <div style="$FIELD">
        <svg $SVG style="color:var(--faint);flex:none;"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>
        <span>kian@kianshop.ir</span>
      </div>
    </label>

    <label style="display:block;">
      <span style="$LAB">Password</span>
      <div style="$FIELDON">
        <svg $SVG style="color:var(--faint);flex:none;"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>
        <span style="flex:1;letter-spacing:0.18em;color:var(--ink-2);">••••••••••••••</span>
        <svg $SVG style="color:var(--faint);flex:none;"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.75"/></svg>
      </div>
    </label>

    <div style="display:flex;gap:5px;margin:10px 0 8px;">
      <div style="flex:1;height:4px;border-radius:999px;background:var(--lime);"></div>
      <div style="flex:1;height:4px;border-radius:999px;background:var(--lime);"></div>
      <div style="flex:1;height:4px;border-radius:999px;background:var(--lime);"></div>
      <div style="flex:1;height:4px;border-radius:999px;background:var(--n200);"></div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;font-size:13px;">
      <span style="display:flex;align-items:center;gap:6px;color:var(--ok);font-weight:550;">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
        14 characters
      </span>
      <span style="color:var(--faint);">10 is the minimum</span>
    </div>

    <div style="margin-top:24px;"><button style="$BTN">Create account</button></div>

    <p style="margin:16px 0 0;font-size:13px;color:var(--faint);line-height:1.5;">We send a confirmation link to that address. Nothing goes live until you confirm it.</p>
  </div>

  <div style="padding:0 24px 34px;text-align:center;color:var(--muted);font-size:14px;">
    Already have an account? <span style="color:var(--accent);font-weight:600;">Sign in</span>
  </div>
</div>
EOF
tail_; } > SignUp.dc.html

# ═══ 4. Check your email ═════════════════════════════════════════════════════
{ top; cat <<EOF
<div style="$L;$F;$FRAME">
  <div style="flex:1;padding:22px 24px 0;display:flex;flex-direction:column;">
    <div style="width:44px;height:44px;margin-left:-10px;display:flex;align-items:center;justify-content:center;color:var(--ink-2);">
      <svg $SVGN><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>
    </div>

    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding-bottom:130px;">
      <div style="width:88px;height:88px;border-radius:26px;background:var(--accent-soft);border:1px solid var(--accent-edge);display:flex;align-items:center;justify-content:center;color:var(--accent);margin-bottom:28px;">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>
      </div>

      <h1 style="margin:0 0 10px;font-size:28px;line-height:1.2;font-weight:650;letter-spacing:-0.02em;">Check your email</h1>
      <p style="margin:0 0 6px;color:var(--muted);line-height:1.55;">We sent a confirmation link to</p>
      <p style="margin:0 0 24px;font-weight:600;font-size:17px;">kian@kianshop.ir</p>

      <div style="display:flex;align-items:center;gap:9px;padding:12px 14px;border-radius:12px;background:var(--surface-3);color:var(--muted);font-size:13px;margin-bottom:28px;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/></svg>
        <span>The link works for one hour.</span>
      </div>

      <button style="$GHOST">Send it again</button>
    </div>
  </div>

  <div style="padding:0 24px 34px;text-align:center;color:var(--muted);font-size:14px;">
    Wrong address? <span style="color:var(--accent);font-weight:600;">Start over</span>
  </div>
</div>
EOF
tail_; } > CheckEmail.dc.html

# ═══ 5. Recovery codes ═══════════════════════════════════════════════════════
{ top; cat <<EOF
<div style="$L;$F;$FRAME">
  <div style="flex:1;padding:22px 24px 0;">
    <div style="width:44px;height:44px;margin-left:-10px;display:flex;align-items:center;justify-content:center;color:var(--ink-2);">
      <svg $SVGN><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>
    </div>

    <h1 style="margin:22px 0 8px;font-size:27px;line-height:1.2;font-weight:650;letter-spacing:-0.02em;">Save your recovery codes</h1>
    <p style="margin:0 0 20px;color:var(--muted);line-height:1.5;">Each one signs you in once if you lose your authenticator.</p>

    <div style="$CARD;padding:16px 14px;display:grid;grid-template-columns:1fr 1fr;gap:11px 12px;$M;font-size:14.5px;letter-spacing:0.03em;color:var(--ink-2);">
      <span>4f2a-91cd</span><span>7b30-e5a1</span>
      <span>c18e-4d72</span><span>0a95-bf36</span>
      <span>e63d-2c08</span><span>91b7-6a4f</span>
      <span>3d5c-8e10</span><span>b204-97da</span>
      <span>6ef1-30b8</span><span>a87c-15e9</span>
    </div>

    <div style="display:flex;gap:10px;margin-top:14px;">
      <button style="$GHOST;height:44px;font-size:14px;">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"/></svg>
        Copy
      </button>
      <button style="$GHOST;height:44px;font-size:14px;">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>
        Download
      </button>
    </div>

    <div style="display:flex;gap:11px;margin-top:20px;padding:13px 14px;border-radius:12px;background:var(--warn-soft);color:var(--warn);font-size:13px;line-height:1.45;">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:1px;"><path d="M12 4.5 21 19H3Z"/><path d="M12 10v4M12 16.8v.1"/></svg>
      <span>This is the only time you will see them. We keep hashes, not the codes, so we cannot show them again.</span>
    </div>
  </div>

  <div style="padding:0 24px 34px;">
    <button style="$BTN">I have saved them</button>
  </div>
</div>
EOF
tail_; } > RecoveryCodes.dc.html

# ── the bottom bar the merchant dashboard actually has (5 slots, last is More) ─
nav() { # $1 = active slot
  local a="$1" i c lab ico
  printf '<nav style="margin-top:auto;flex:none;display:flex;padding:6px 4px 22px;background:var(--surface);border-top:1px solid var(--line);">'
  for i in 1 2 3 4 5; do
    case $i in
      1) lab=Overview; ico='<path d="M3 10.5 12 3.2l9 7.3"/><path d="M5.6 9.4V20.8h12.8V9.4"/>' ;;
      2) lab=New;      ico='<circle cx="12" cy="12" r="8.8"/><path d="M12 8.2v7.6M8.2 12h7.6"/>' ;;
      3) lab=Invoices; ico='<rect x="4.5" y="3.2" width="15" height="17.6" rx="2.4"/><path d="M8 8h8M8 12h8M8 16h5"/>' ;;
      4) lab=Payouts;  ico='<rect x="3" y="6" width="18" height="12.8" rx="3"/><path d="M3 10h18"/><path d="M16.5 14.6h2"/>' ;;
      5) lab=More;     ico='<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>' ;;
    esac
    if [ "$i" = "$a" ]; then c='var(--accent);font-weight:600'; else c='var(--faint);font-weight:500'; fi
    printf '<div style="flex:1;min-height:44px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;color:%s;font-size:11px;"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">%s</svg><span>%s</span></div>' "$c" "$ico" "$lab"
  done
  printf '</nav>'
}

# ── one row of the recent-payments list ──────────────────────────────────────
prow() { # $1 asset  $2 chain  $3 when  $4 amount  $5 state  $6 colour-var  $7 soft-var
  cat <<ROW
<div style="display:flex;align-items:center;gap:12px;padding:11px 0;border-top:1px solid var(--line);">
  <div style="width:38px;height:38px;flex:none;border-radius:12px;background:var(--surface-3);color:var(--ink-2);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:650;letter-spacing:-0.01em;">$1</div>
  <div style="flex:1;min-width:0;">
    <div style="font-size:14.5px;font-weight:550;">$1 <span style="color:var(--faint);font-weight:400;">on</span> $2</div>
    <div style="font-size:12.5px;color:var(--faint);">$3</div>
  </div>
  <div style="text-align:right;">
    <div style="font-size:14.5px;font-weight:600;font-variant-numeric:tabular-nums;">\$$4</div>
    <div style="display:inline-flex;margin-top:2px;padding:1px 8px;border-radius:999px;background:var($7);color:var($6);font-size:11px;font-weight:600;">$5</div>
  </div>
</div>
ROW
}

# ═══ 6. Overview (home) ══════════════════════════════════════════════════════
{ top; cat <<EOF
<div style="$L;$F;$FRAME">
  <div style="flex:1;min-height:0;overflow:hidden;padding:18px 20px 0;">

    <div style="display:flex;align-items:center;gap:11px;margin-bottom:20px;">
      <div style="width:40px;height:40px;border-radius:13px;background:var(--accent-soft);border:1px solid var(--accent-edge);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;">K</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:7px;">
          <span style="font-size:16px;font-weight:600;letter-spacing:-0.01em;">Kian Shop</span>
          <span style="padding:1px 7px;border-radius:999px;background:var(--ok-soft);color:var(--ok);font-size:11px;font-weight:650;">live</span>
        </div>
        <div style="font-size:12.5px;color:var(--faint);">Rate reviewed 1 Oct</div>
      </div>
      <div style="width:40px;height:40px;border-radius:12px;border:1px solid var(--line);background:var(--surface);display:flex;align-items:center;justify-content:center;color:var(--ink-2);">
        <svg $SVG><path d="M6 9.5a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13.5 6 9.5Z"/><path d="M10 18.5a2 2 0 0 0 4 0"/></svg>
      </div>
    </div>

    <div style="border-radius:18px;background:#14171c;color:#f2f4f6;padding:18px 18px 16px;box-shadow:0 10px 24px rgba(16,24,40,0.14);">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:12.5px;color:#a3abb6;font-weight:500;">Processed this period</span>
        <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:rgba(200,241,53,0.14);color:var(--lime);font-size:11.5px;font-weight:650;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15.5 12 8.5l7 7"/></svg>18%
        </span>
      </div>
      <div style="margin:6px 0 14px;font-size:34px;font-weight:650;letter-spacing:-0.03em;font-variant-numeric:tabular-nums">\$12,480.20</div>
      <div style="display:flex;border-top:1px solid #262c35;padding-top:12px;">
        <div style="flex:1;">
          <div style="font-size:11.5px;color:#7d8591;">Commission 1.2%</div>
          <div style="font-size:15px;font-weight:600;margin-top:1px;">\$149.76</div>
        </div>
        <div style="width:1px;background:#262c35;margin:0 14px;"></div>
        <div style="flex:1;">
          <div style="font-size:11.5px;color:#7d8591;">Paid invoices</div>
          <div style="font-size:15px;font-weight:600;margin-top:1px;">128</div>
        </div>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin:16px 0 16px;">
      <div style="flex:1;text-align:center;">
        <div style="height:52px;border-radius:15px;background:var(--lime);color:var(--lime-ink);display:flex;align-items:center;justify-content:center;">
          <svg $SVGN stroke-width="2"><path d="M12 6v12M6 12h12"/></svg>
        </div>
        <div style="font-size:11.5px;font-weight:550;margin-top:6px;">Take payment</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="height:52px;border-radius:15px;background:var(--surface);border:1px solid var(--line);color:var(--ink-2);display:flex;align-items:center;justify-content:center;">
          <svg $SVGN><rect x="3" y="6" width="18" height="12.8" rx="3"/><path d="M3 10h18"/><path d="M16.5 14.6h2"/></svg>
        </div>
        <div style="font-size:11.5px;font-weight:550;margin-top:6px;">Wallets</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="height:52px;border-radius:15px;background:var(--surface);border:1px solid var(--line);color:var(--ink-2);display:flex;align-items:center;justify-content:center;">
          <svg $SVGN><path d="M10.5 13.5 4 20"/><path d="M13.5 10.5a4.2 4.2 0 1 0 5.2-5.2l-2.4 2.4-2.6-.6-.6-2.6 2.4-2.4a4.2 4.2 0 0 0-5.2 5.2"/></svg>
        </div>
        <div style="font-size:11.5px;font-weight:550;margin-top:6px;">API keys</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="height:52px;border-radius:15px;background:var(--surface);border:1px solid var(--line);color:var(--ink-2);display:flex;align-items:center;justify-content:center;">
          <svg $SVGN><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>
        </div>
        <div style="font-size:11.5px;font-weight:550;margin-top:6px;">Security</div>
      </div>
    </div>

    <div style="$CARD;padding:14px 15px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;">
        <span style="font-size:14.5px;font-weight:600;">Before your first live payment</span>
        <span style="font-size:12.5px;color:var(--faint);">3 of 5</span>
      </div>
      <div style="height:6px;border-radius:999px;background:var(--surface-3);overflow:hidden;">
        <div style="width:60%;height:100%;background:var(--lime);border-radius:999px;"></div>
      </div>
      <div style="display:flex;align-items:center;gap:7px;margin-top:10px;font-size:13px;color:var(--muted);">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent);flex:none;"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5l3 1.5"/></svg>
        <span>Next: add a wallet on a second chain</span>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
      <span style="font-size:14.5px;font-weight:600;">Recent payments</span>
      <span style="font-size:13px;color:var(--accent);font-weight:600;">All</span>
    </div>
    $(prow "USDT" "TRON" "2 minutes ago" "20.03" "Credited" "--ok" "--ok-soft")
    $(prow "USDT" "BSC" "41 minutes ago" "149.05" "Credited" "--ok" "--ok-soft")
    $(prow "USDC" "Polygon" "Today, 09:12" "18.90" "Underpaid" "--warn" "--warn-soft")
  </div>
  $(nav 1)
</div>
EOF
tail_; } > Overview.dc.html

# ── a stand-in QR block: real finder squares, deterministic speckle between ───
qr() {
  local n=25 r c out=""
  out+='<svg width="176" height="176" viewBox="0 0 25 25" shape-rendering="crispEdges" aria-hidden="true">'
  out+='<rect width="25" height="25" fill="#ffffff"/>'
  for ((r=0;r<n;r++)); do for ((c=0;c<n;c++)); do
    if { [ $r -lt 8 ] && [ $c -lt 8 ]; } || { [ $r -lt 8 ] && [ $c -ge 17 ]; } || { [ $r -ge 17 ] && [ $c -lt 8 ]; }; then continue; fi
    if [ $(( (r*7 + c*13 + r*c*3) % 3 )) -eq 0 ]; then out+="<rect x=\"$c\" y=\"$r\" width=\"1\" height=\"1\" fill=\"#1a1d22\"/>"; fi
  done; done
  for p in "0 0" "18 0" "0 18"; do
    set -- $p
    out+="<rect x=\"$1\" y=\"$2\" width=\"7\" height=\"7\" fill=\"#1a1d22\"/>"
    out+="<rect x=\"$(($1+1))\" y=\"$(($2+1))\" width=\"5\" height=\"5\" fill=\"#ffffff\"/>"
    out+="<rect x=\"$(($1+2))\" y=\"$(($2+2))\" width=\"3\" height=\"3\" fill=\"#1a1d22\"/>"
  done
  out+='</svg>'
  printf '%s' "$out"
}

# ═══ 7. Take a payment (sheet) ═══════════════════════════════════════════════
opt() { # $1 asset  $2 chain  $3 detail  $4 on/off
  local ring dot
  if [ "$4" = on ]; then ring='var(--accent-edge);background:var(--accent-soft)'; dot='<div style="width:20px;height:20px;border-radius:999px;border:6px solid var(--accent);box-sizing:border-box;flex:none;"></div>';
  else ring='var(--line);background:var(--surface)'; dot='<div style="width:20px;height:20px;border-radius:999px;border:1.5px solid var(--line-strong);box-sizing:border-box;flex:none;"></div>'; fi
  cat <<OPT
<div style="display:flex;align-items:center;gap:12px;padding:13px 14px;border:1px solid $ring;border-radius:13px;margin-bottom:9px;">
  <div style="width:34px;height:34px;flex:none;border-radius:11px;background:var(--surface-3);color:var(--ink-2);display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:650;">$1</div>
  <div style="flex:1;min-width:0;">
    <div style="font-size:14.5px;font-weight:550;">$1 on $2</div>
    <div style="font-size:12.5px;color:var(--faint);">$3</div>
  </div>
  $dot
</div>
OPT
}
{ top; cat <<EOF
<div style="$L;$F;$FRAME;position:relative;">
  <div style="flex:none;height:196px;padding:18px 20px 0;">
    <div style="display:flex;align-items:center;gap:11px;margin-bottom:20px;">
      <div style="width:40px;height:40px;border-radius:13px;background:var(--accent-soft);border:1px solid var(--accent-edge);"></div>
      <div style="flex:1;"><div style="height:11px;width:110px;border-radius:6px;background:var(--n200);"></div><div style="height:9px;width:74px;border-radius:6px;background:var(--n100);margin-top:7px;"></div></div>
    </div>
    <div style="height:120px;border-radius:18px;background:#14171c;"></div>
  </div>

  <div style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(12,14,17,0.5);"></div>

  <div style="position:relative;flex:1;background:var(--surface);border-radius:22px 22px 0 0;padding:10px 20px 0;box-shadow:0 -14px 40px rgba(16,24,40,0.22);display:flex;flex-direction:column;">
    <div style="width:38px;height:4px;border-radius:999px;background:var(--line-strong);margin:0 auto 16px;"></div>

    <h2 style="margin:0 0 3px;font-size:20px;font-weight:650;letter-spacing:-0.015em;">Take a payment</h2>
    <p style="margin:0 0 18px;color:var(--muted);font-size:13.5px;">The buyer pays one exact amount. That amount is how we recognise it.</p>

    <div style="display:flex;align-items:baseline;gap:3px;padding:14px 16px;border:1px solid var(--accent-edge);border-radius:14px;box-shadow:0 0 0 3px rgba(95,122,0,0.15);margin-bottom:8px;">
      <span style="font-size:26px;font-weight:600;color:var(--faint);">\$</span>
      <span style="font-size:34px;font-weight:650;letter-spacing:-0.035em;font-variant-numeric:tabular-nums">20.00</span>
      <span style="flex:1;"></span>
      <span style="font-size:13px;color:var(--faint);font-weight:550;">USD</span>
    </div>
    <p style="margin:0 0 18px;font-size:12.5px;color:var(--faint);">No minimum on a wallet of your own.</p>

    <div style="font-size:13px;font-weight:600;color:var(--ink-2);margin-bottom:9px;">Paid into</div>
    $(opt "USDT" "TRON" "Your wallet · TR7N…9h4c · free" on)
    $(opt "USDT" "BSC" "Your wallet · 0x4f…21ab · free" off)
    $(opt "USDC" "Polygon" "Forwarder contract · gas from the buyer" off)

    <div style="margin-top:auto;padding:14px 0 30px;">
      <button style="$BTN">Create the invoice</button>
    </div>
  </div>
</div>
EOF
tail_; } > TakePayment.dc.html

# ═══ 8. The invoice, as the buyer sees it ════════════════════════════════════
{ top; cat <<EOF
<div style="$L;$F;$FRAME">
  <div style="flex:1;padding:20px 20px 0;display:flex;flex-direction:column;align-items:center;">

    <div style="width:100%;display:flex;align-items:center;gap:10px;margin-bottom:22px;">
      <div style="width:32px;height:32px;border-radius:10px;background:var(--accent-soft);border:1px solid var(--accent-edge);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;">K</div>
      <span style="flex:1;font-size:15px;font-weight:600;">Kian Shop</span>
      <span style="font-size:13px;color:var(--muted);">Order 4192</span>
    </div>

    <div style="font-size:13px;color:var(--muted);font-weight:550;">Send exactly</div>
    <div style="margin:4px 0 3px;font-size:38px;font-weight:650;letter-spacing:-0.035em;font-variant-numeric:tabular-nums">20.03 <span style="font-size:22px;font-weight:600;color:var(--ink-2);">USDT</span></div>
    <div style="font-size:13.5px;color:var(--faint);margin-bottom:18px;">\$20.03 · TRON network</div>

    <div style="padding:14px;border-radius:18px;background:var(--n0);border:1px solid var(--line);box-shadow:0 4px 14px rgba(16,24,40,0.07);line-height:0;">$(qr)</div>

    <div style="width:100%;display:flex;align-items:center;gap:10px;margin-top:18px;padding:12px 14px;border:1px solid var(--line);border-radius:13px;background:var(--surface);box-sizing:border-box;">
      <div style="flex:1;min-width:0;">
        <div style="font-size:11.5px;color:var(--faint);font-weight:550;margin-bottom:2px;">TRON address</div>
        <div style="$M;font-size:13.5px;letter-spacing:-0.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t</div>
      </div>
      <div style="width:38px;height:38px;flex:none;border-radius:11px;background:var(--surface-3);color:var(--ink-2);display:flex;align-items:center;justify-content:center;">
        <svg $SVG><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5"/></svg>
      </div>
    </div>

    <div style="width:100%;display:flex;gap:10px;margin-top:12px;padding:12px 14px;border-radius:13px;background:var(--accent-soft);border:1px solid var(--accent-edge);color:var(--accent);font-size:12.5px;line-height:1.45;box-sizing:border-box;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" style="flex:none;margin-top:1px;"><circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/></svg>
      <span>The last two digits belong to this order. <span style="font-weight:650;">20.00</span> or <span style="font-weight:650;">20.05</span> will not match it.</span>
    </div>

    <div style="display:flex;align-items:center;gap:10px;margin-top:14px;font-size:12.5px;color:var(--faint);">
      <span>Confirms in about a minute</span><span>·</span><span>network fee about \$0.008</span>
    </div>

    <div style="width:100%;margin-top:auto;padding-bottom:16px;">
      <button style="$GHOST;height:46px;font-size:14px;">
        Pay on another network
        <svg $SVG style="color:var(--n400);"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg>
      </button>
    </div>
  </div>

  <div style="padding:14px 20px 30px;border-top:1px solid var(--line);background:var(--surface);">
    <div style="display:flex;align-items:center;gap:9px;">
      <span style="width:9px;height:9px;border-radius:999px;background:var(--lime);box-shadow:0 0 0 4px rgba(200,241,53,0.35);flex:none;"></span>
      <span style="flex:1;font-size:14px;font-weight:550;">Waiting for your transfer</span>
      <span style="display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;background:var(--surface-3);color:var(--muted);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/></svg>14:52
      </span>
    </div>
    <div style="margin-top:11px;font-size:11.5px;color:var(--faint);text-align:center;">Non-custodial — this address is the merchant's own. Secured by AVEX Pay.</div>
  </div>
</div>
EOF
tail_; } > Invoice.dc.html

# ═══ 9. Payouts — the merchant's own wallets ═════════════════════════════════
wrow() { # $1 chain  $2 address  $3 state  $4 colour  $5 soft
  cat <<W
<div style="display:flex;align-items:center;gap:12px;padding:12px 0;border-top:1px solid var(--line);">
  <div style="width:36px;height:36px;flex:none;border-radius:11px;background:var(--surface-3);color:var(--ink-2);display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:650;letter-spacing:0.01em;">$1</div>
  <div style="flex:1;min-width:0;">
    <div style="$M;font-size:13.5px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">$2</div>
    <div style="display:inline-flex;margin-top:3px;padding:1px 7px;border-radius:999px;background:var($5);color:var($4);font-size:11px;font-weight:600;">$3</div>
  </div>
  <svg $SVG style="color:var(--n400);flex:none;"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg>
</div>
W
}
{ top; cat <<EOF
<div style="$L;$F;$FRAME">
  <div style="flex:1;min-height:0;overflow:hidden;padding:22px 20px 0;">
    <h1 style="margin:0 0 4px;font-size:26px;font-weight:650;letter-spacing:-0.022em;">Payouts</h1>
    <p style="margin:0 0 20px;color:var(--muted);font-size:14px;">Where the money lands. The keys stay with you — we only ever hold the address.</p>

    <div style="$CARD;padding:15px 16px 8px;margin-bottom:14px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:15px;font-weight:600;">Your own wallets</span>
        <span style="padding:2px 8px;border-radius:999px;background:var(--surface-3);color:var(--muted);font-size:11.5px;font-weight:600;">4 of 10 per chain</span>
      </div>
      <p style="margin:5px 0 4px;font-size:12.5px;color:var(--faint);line-height:1.45;">No contract, no gas, no minimum. Each invoice asks for its own exact amount.</p>
      $(wrow "TRON" "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" "Active" "--ok" "--ok-soft")
      $(wrow "BSC" "0x4f21c9e0a7b3d81452ffab9017c6d3e5a90b21ab" "Active" "--ok" "--ok-soft")
      $(wrow "POL" "0x9c3e77d15b0a4e628ff1c2d9e4b7a3106d8877d1" "Active" "--ok" "--ok-soft")
      $(wrow "ETH" "0x11aab204c7e3f915d0628ba4c19e77d3f0b204aa" "Waiting for your confirmation" "--warn" "--warn-soft")
    </div>

    <div style="display:flex;align-items:center;justify-content:center;gap:8px;height:48px;border:1px dashed var(--line-strong);border-radius:13px;color:var(--accent);font-size:14.5px;font-weight:600;margin-bottom:20px;">
      <svg $SVG stroke-width="2"><path d="M12 6v12M6 12h12"/></svg>
      Add a wallet
    </div>

    <div style="$CARD;padding:15px 16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
        <span style="font-size:15px;font-weight:600;">Contract settlement</span>
        <span style="padding:2px 8px;border-radius:999px;background:var(--info-soft);color:var(--info);font-size:11.5px;font-weight:600;">optional</span>
      </div>
      <p style="margin:0 0 10px;font-size:12.5px;color:var(--faint);line-height:1.45;">The other route: a forwarder contract per invoice on EVM chains. The buyer pays the gas, so it carries a minimum.</p>
      <div style="display:flex;align-items:center;gap:10px;padding-top:11px;border-top:1px solid var(--line);">
        <div style="flex:1;min-width:0;">
          <div style="font-size:11.5px;color:var(--faint);font-weight:550;margin-bottom:2px;">Settles to</div>
          <div style="$M;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">0x5c8b02fa17e3d941b6c07ab29d5e4318fa77c02b</div>
        </div>
        <svg $SVG style="color:var(--n400);flex:none;"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg>
      </div>
    </div>
  </div>
  $(nav 4)
</div>
EOF
tail_; } > Payouts.dc.html

# ═══ 10. Security ════════════════════════════════════════════════════════════
srow() { # $1 title  $2 sub  $3 icon-path  $4 pill  $5 colour  $6 soft  $7 "first" to drop the rule
  local pill="" rule="border-top:1px solid var(--line);"
  [ -n "$4" ] && pill="<span style=\"padding:2px 8px;border-radius:999px;background:var($6);color:var($5);font-size:11.5px;font-weight:650;flex:none;\">$4</span>"
  [ "${7:-}" = first ] && rule=""
  cat <<S
<div style="display:flex;align-items:center;gap:12px;padding:13px 0;$rule">
  <div style="width:36px;height:36px;flex:none;border-radius:11px;background:var(--surface-3);color:var(--ink-2);display:flex;align-items:center;justify-content:center;">
    <svg $SVG>$3</svg>
  </div>
  <div style="flex:1;min-width:0;">
    <div style="font-size:14.5px;font-weight:550;">$1</div>
    <div style="font-size:12.5px;color:var(--faint);">$2</div>
  </div>
  $pill
  <svg $SVG style="color:var(--n400);flex:none;"><path d="M9.5 5.5 16 12l-6.5 6.5"/></svg>
</div>
S
}
{ top; cat <<EOF
<div style="$L;$F;$FRAME">
  <div style="flex:1;min-height:0;overflow:hidden;padding:22px 20px 0;">
    <h1 style="margin:0 0 4px;font-size:26px;font-weight:650;letter-spacing:-0.022em;">Security</h1>
    <p style="margin:0 0 18px;color:var(--muted);font-size:14px;">Who can reach this account, and with what.</p>

    <div style="$CARD;padding:4px 16px 8px;margin-bottom:14px;">
      $(srow "Two-factor authentication" "Authenticator app · added 12 Aug" '<rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/>' "On" "--ok" "--ok-soft" first)
      $(srow "Recovery codes" "7 of 10 still unused" '<path d="M15 7.5a4.5 4.5 0 1 0-4.4 4.5L4 18.6V21h3.4l1-1v-2h2v-2h2l1.6-1.6A4.5 4.5 0 0 0 15 7.5Z"/>' "" "" "")
      $(srow "Password" "Changed two months ago" '<circle cx="12" cy="12" r="8.5"/><path d="M12 8.4v4.2l2.8 1.6"/>' "" "" "")
      $(srow "Signed-in devices" "This phone and one browser" '<rect x="3" y="5" width="18" height="12" rx="2.5"/><path d="M8.5 20.5h7"/>' "2" "--muted" "--surface-3")
    </div>

    <div style="font-size:12px;font-weight:650;color:var(--faint);letter-spacing:0.06em;text-transform:uppercase;margin:0 0 8px 2px;">Developer</div>
    <div style="$CARD;padding:4px 16px 8px;margin-bottom:14px;">
      $(srow "API keys" "Two live, one test" '<path d="M10.5 13.5 4 20"/><path d="M13.5 10.5a4.2 4.2 0 1 0 5.2-5.2l-2.4 2.4-2.6-.6-.6-2.6 2.4-2.4a4.2 4.2 0 0 0-5.2 5.2"/>' "" "" "" first)
      $(srow "Webhooks" "One endpoint · last delivery 12:04" '<path d="M8.5 9.5 12 4l3.5 5.5"/><path d="M4.5 16.5 8 11M19.5 16.5 16 11"/><circle cx="12" cy="17.5" r="2.5"/>' "OK" "--ok" "--ok-soft")
    </div>

    <div style="font-size:12px;font-weight:650;color:var(--faint);letter-spacing:0.06em;text-transform:uppercase;margin:0 0 8px 2px;">Appearance</div>
    <div style="display:flex;gap:4px;padding:4px;border-radius:12px;background:var(--surface-3);margin-bottom:18px;">
      <div style="flex:1;height:36px;border-radius:9px;background:var(--surface);box-shadow:0 1px 2px rgba(16,24,40,0.08);display:flex;align-items:center;justify-content:center;font-size:13.5px;font-weight:600;">System</div>
      <div style="flex:1;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:13.5px;color:var(--muted);">Light</div>
      <div style="flex:1;height:36px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:13.5px;color:var(--muted);">Dark</div>
    </div>

    <div style="display:flex;align-items:center;justify-content:center;gap:8px;height:46px;border:1px solid var(--line);border-radius:12px;color:var(--danger);font-size:14.5px;font-weight:600;background:var(--surface);">
      <svg $SVG><path d="M14 4.5H6.5A1.5 1.5 0 0 0 5 6v12a1.5 1.5 0 0 0 1.5 1.5H14"/><path d="m17 8.5 3.5 3.5L17 15.5"/><path d="M20 12H10"/></svg>
      Sign out
    </div>
  </div>
  $(nav 5)
</div>
EOF
tail_; } > Security.dc.html

# ═══ 11. Overview, dark ══════════════════════════════════════════════════════
{ top; cat <<EOF
<div style="$D;$F;$FRAME">
  <div style="flex:1;min-height:0;overflow:hidden;padding:18px 20px 0;">

    <div style="display:flex;align-items:center;gap:11px;margin-bottom:20px;">
      <div style="width:40px;height:40px;border-radius:13px;background:var(--accent-soft);border:1px solid var(--accent-edge);color:var(--accent);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:16px;">K</div>
      <div style="flex:1;min-width:0;">
        <div style="display:flex;align-items:center;gap:7px;">
          <span style="font-size:16px;font-weight:600;letter-spacing:-0.01em;">Kian Shop</span>
          <span style="padding:1px 7px;border-radius:999px;background:var(--ok-soft);color:var(--ok);font-size:11px;font-weight:650;">live</span>
        </div>
        <div style="font-size:12.5px;color:var(--faint);">Rate reviewed 1 Oct</div>
      </div>
      <div style="width:40px;height:40px;border-radius:12px;border:1px solid var(--line);background:var(--surface);display:flex;align-items:center;justify-content:center;color:var(--ink-2);">
        <svg $SVG><path d="M6 9.5a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13.5 6 9.5Z"/><path d="M10 18.5a2 2 0 0 0 4 0"/></svg>
      </div>
    </div>

    <div style="border-radius:18px;background:var(--lime);color:#1a2400;padding:18px 18px 16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:12.5px;color:rgba(26,36,0,0.66);font-weight:600;">Processed this period</span>
        <span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:rgba(26,36,0,0.12);font-size:11.5px;font-weight:700;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 15.5 12 8.5l7 7"/></svg>18%
        </span>
      </div>
      <div style="margin:6px 0 14px;font-size:34px;font-weight:650;letter-spacing:-0.03em;font-variant-numeric:tabular-nums">\$12,480.20</div>
      <div style="display:flex;border-top:1px solid rgba(26,36,0,0.16);padding-top:12px;">
        <div style="flex:1;">
          <div style="font-size:11.5px;color:rgba(26,36,0,0.6);font-weight:550;">Commission 1.2%</div>
          <div style="font-size:15px;font-weight:650;margin-top:1px;">\$149.76</div>
        </div>
        <div style="width:1px;background:rgba(26,36,0,0.16);margin:0 14px;"></div>
        <div style="flex:1;">
          <div style="font-size:11.5px;color:rgba(26,36,0,0.6);font-weight:550;">Paid invoices</div>
          <div style="font-size:15px;font-weight:650;margin-top:1px;">128</div>
        </div>
      </div>
    </div>

    <div style="display:flex;gap:10px;margin:16px 0 16px;">
      <div style="flex:1;text-align:center;">
        <div style="height:52px;border-radius:15px;background:var(--surface-3);color:var(--accent);display:flex;align-items:center;justify-content:center;">
          <svg $SVGN stroke-width="2"><path d="M12 6v12M6 12h12"/></svg>
        </div>
        <div style="font-size:11.5px;font-weight:550;margin-top:6px;">Take payment</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="height:52px;border-radius:15px;background:var(--surface);border:1px solid var(--line);color:var(--ink-2);display:flex;align-items:center;justify-content:center;">
          <svg $SVGN><rect x="3" y="6" width="18" height="12.8" rx="3"/><path d="M3 10h18"/><path d="M16.5 14.6h2"/></svg>
        </div>
        <div style="font-size:11.5px;font-weight:550;margin-top:6px;">Wallets</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="height:52px;border-radius:15px;background:var(--surface);border:1px solid var(--line);color:var(--ink-2);display:flex;align-items:center;justify-content:center;">
          <svg $SVGN><path d="M10.5 13.5 4 20"/><path d="M13.5 10.5a4.2 4.2 0 1 0 5.2-5.2l-2.4 2.4-2.6-.6-.6-2.6 2.4-2.4a4.2 4.2 0 0 0-5.2 5.2"/></svg>
        </div>
        <div style="font-size:11.5px;font-weight:550;margin-top:6px;">API keys</div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="height:52px;border-radius:15px;background:var(--surface);border:1px solid var(--line);color:var(--ink-2);display:flex;align-items:center;justify-content:center;">
          <svg $SVGN><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>
        </div>
        <div style="font-size:11.5px;font-weight:550;margin-top:6px;">Security</div>
      </div>
    </div>

    <div style="background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:14px 15px;margin-bottom:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:9px;">
        <span style="font-size:14.5px;font-weight:600;">Before your first live payment</span>
        <span style="font-size:12.5px;color:var(--faint);">3 of 5</span>
      </div>
      <div style="height:6px;border-radius:999px;background:var(--surface-3);overflow:hidden;">
        <div style="width:60%;height:100%;background:var(--lime);border-radius:999px;"></div>
      </div>
      <div style="display:flex;align-items:center;gap:7px;margin-top:10px;font-size:13px;color:var(--muted);">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent);flex:none;"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5l3 1.5"/></svg>
        <span>Next: add a wallet on a second chain</span>
      </div>
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px;">
      <span style="font-size:14.5px;font-weight:600;">Recent payments</span>
      <span style="font-size:13px;color:var(--accent);font-weight:600;">All</span>
    </div>
    $(prow "USDT" "TRON" "2 minutes ago" "20.03" "Credited" "--ok" "--ok-soft")
    $(prow "USDT" "BSC" "41 minutes ago" "149.05" "Credited" "--ok" "--ok-soft")
    $(prow "USDC" "Polygon" "Today, 09:12" "18.90" "Underpaid" "--warn" "--warn-soft")
  </div>
  $(nav 1)
</div>
EOF
tail_; } > OverviewDark.dc.html

# ═══ 12. Sign in, dark ═══════════════════════════════════════════════════════
{ top; cat <<EOF
<div style="$D;$F;$FRAME">
  <div style="padding:56px 24px 0;">
    $(mark)
  </div>
  <div style="flex:1;display:flex;flex-direction:column;justify-content:center;padding:0 24px 44px;">
    <h1 style="margin:0 0 6px;font-size:30px;line-height:1.15;font-weight:650;letter-spacing:-0.022em;">Sign in</h1>
    <p style="margin:0 0 30px;color:var(--muted);">To your merchant dashboard.</p>

    <label style="display:block;margin-bottom:16px;">
      <span style="$LAB">Email</span>
      <div style="display:flex;align-items:center;gap:10px;height:48px;padding:0 14px;border:1px solid var(--line-strong);border-radius:10px;background:var(--surface);box-sizing:border-box;">
        <svg $SVG style="color:var(--faint);flex:none;"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>
        <span>kian@kianshop.ir</span>
      </div>
    </label>

    <label style="display:block;margin-bottom:10px;">
      <span style="$LAB">Password</span>
      <div style="display:flex;align-items:center;gap:10px;height:48px;padding:0 14px;border:1px solid var(--accent-edge);border-radius:10px;background:var(--surface);box-sizing:border-box;box-shadow:0 0 0 3px rgba(200,241,53,0.22);">
        <svg $SVG style="color:var(--faint);flex:none;"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>
        <span style="flex:1;letter-spacing:0.18em;color:var(--ink-2);">••••••••••••</span>
        <svg $SVG style="color:var(--faint);flex:none;"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="2.75"/></svg>
      </div>
    </label>
    <p style="margin:0 0 26px;font-size:13px;color:var(--faint);">At least 10 characters — the only rule we set.</p>

    <button style="$BTN">Sign in</button>

    <div style="display:flex;align-items:center;gap:9px;margin:22px 0 0;color:var(--muted);font-size:13px;">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;"><rect x="4" y="10" width="16" height="10" rx="2.5"/><path d="M8 10V7.5a4 4 0 0 1 8 0V10"/></svg>
      <span>We ask for your authenticator code next.</span>
    </div>
  </div>

  <div style="padding:0 24px 34px;text-align:center;color:var(--muted);font-size:14px;">
    New here? <span style="color:var(--accent);font-weight:600;">Create a merchant account</span>
  </div>
</div>
EOF
tail_; } > SignInDark.dc.html

# ═══ canvas layout ═══════════════════════════════════════════════════════════
cat > canvas.json <<'JSON'
{
  "artboards": [
    { "file": "Main.dc.html",           "title": "Sign in",            "x": 0,    "y": 0,    "w": 390, "h": 844 },
    { "file": "SignUp.dc.html",         "title": "Create account",     "x": 470,  "y": 0,    "w": 390, "h": 844 },
    { "file": "CheckEmail.dc.html",     "title": "Check your email",   "x": 940,  "y": 0,    "w": 390, "h": 844 },
    { "file": "Authenticator.dc.html",  "title": "Authenticator code", "x": 1410, "y": 0,    "w": 390, "h": 844 },
    { "file": "RecoveryCodes.dc.html",  "title": "Recovery codes",     "x": 1880, "y": 0,    "w": 390, "h": 844 },

    { "file": "Overview.dc.html",       "title": "Overview",           "x": 0,    "y": 1004, "w": 390, "h": 844 },
    { "file": "TakePayment.dc.html",    "title": "Take a payment",     "x": 470,  "y": 1004, "w": 390, "h": 844 },
    { "file": "Invoice.dc.html",        "title": "Invoice (buyer)",    "x": 940,  "y": 1004, "w": 390, "h": 844 },
    { "file": "Payouts.dc.html",        "title": "Payouts",            "x": 1410, "y": 1004, "w": 390, "h": 844 },
    { "file": "Security.dc.html",       "title": "Security",           "x": 1880, "y": 1004, "w": 390, "h": 844 },

    { "file": "SignInDark.dc.html",     "title": "Sign in — dark",     "x": 0,    "y": 2008, "w": 390, "h": 844 },
    { "file": "OverviewDark.dc.html",   "title": "Overview — dark",    "x": 470,  "y": 2008, "w": 390, "h": 844 }
  ],
  "launch": { "view": "canvas" }
}
JSON
echo "artboards: $(ls *.dc.html | wc -l), canvas.json written"
