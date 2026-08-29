#!/usr/bin/env bash
#
# Bring an AVEX Pay gateway up on one Linux host.
#
#   sudo bash deploy/install.sh --check      # look at the host, change nothing
#   sudo bash deploy/install.sh --selftest   # generate the files into a temp dir and check them
#   sudo bash deploy/install.sh              # do it
#
# This is docs/GO-LIVE-fa.md steps 02 and 04 through 06, plus 11 and 12, as one run. It exists
# because that document is thirteen steps and most of them are the same few facts typed into five
# files, which is a lot of places to make one mistake.
#
# What it will not do, because it cannot: create your database, create your mail account, fund a
# wallet, click through the dashboard, or send a real payment. It asks for the connection strings
# and does everything downstream of them.
#
# ## The rules it follows
#
# It never overwrites a secret. An existing api.env is left alone unless you pass --reconfigure,
# and even then the old one is kept beside it. A settlement key that exists is never regenerated:
# a new key is a new gas wallet, and the old one still holds the balance.
#
# It never prints a secret. Connection strings and keys are read with the echo off and written
# with mode 0600. The one thing it does print is the settlement wallet's address, because you have
# to fund it.
#
# It is idempotent, so it is also how you apply a config change or pick up a new commit.

set -euo pipefail

# ── paths ────────────────────────────────────────────────────────────────────
#
# Overridable through AVEX_ROOT so --selftest can build into a temporary directory. Nothing else
# should set it.

: "${AVEX_ROOT:=}"
APP_DIR="$AVEX_ROOT/opt/avex"
CONF_DIR="$AVEX_ROOT/etc/avex"
ENV_FILE="$CONF_DIR/api.env"
KEY_FILE="$CONF_DIR/settlement-key"
KEY_CRED="$CONF_DIR/settlement-key.cred"
UNIT_DIR="$AVEX_ROOT/etc/systemd/system"
CADDY_FILE="$AVEX_ROOT/etc/caddy/Caddyfile"
readonly SERVICE_USER=avex
readonly REPO_DEFAULT=https://github.com/masonaescjcj-oss/avex.git

MODE=install

# Where this script lives, so --selftest can validate the generated configuration against the
# real schema in this checkout rather than against a list of key names it might forget to update.
SCRIPT_DIR=$( cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd )
REPO_ROOT=$(dirname "$SCRIPT_DIR")

# The branch and remote default to the ones this script was run from, not to main.
#
# `sync_code` moves $APP_DIR onto $BRANCH from $REPO, so a hardcoded default means running the
# script out of a checkout of anything else silently replaces that code with main's — including
# this script, so the next run would not even have the fix. Somebody who cloned a branch meant
# that branch, and somebody who cloned a fork meant that fork.
BRANCH=main
REPO="$REPO_DEFAULT"
if git -C "$SCRIPT_DIR" rev-parse --git-dir >/dev/null 2>&1; then
  BRANCH=$( git -C "$SCRIPT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo main )
  # A detached HEAD names no branch; main is the honest fallback and --branch overrides it.
  [[ $BRANCH == HEAD ]] && BRANCH=main
  REPO=$( git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null || echo "$REPO_DEFAULT" )
fi

# Filled by detect_host.
SYSTEMD_VERSION=0
NODE_MAJOR=0
KEY_MECHANISM=file
# The absolute path to node, for ExecStart.
#
# Detected rather than hardcoded to /usr/bin/node. That is where apt puts it, but an operator who
# already had node — from nvm, from a tarball in /opt — would get units naming a binary that is
# not there, and the failure arrives as a unit that will not start rather than as anything about
# paths.
NODE_BIN=/usr/bin/node
# The loopback port the API binds. Not a constant, because this host may already have something
# on 3000 — see pick_port.
API_PORT=3000

# Filled by ask_configuration, consumed by write_env_file. Globals because bash has no other way
# to return eight strings, and because none of them may be passed as arguments — an argument is
# visible in `ps` to every user on the host.
db_url='' direct_url='' smtp_url='' mail_from='' operator_email=''
app_url='' tron_rpc=''

# ── output ───────────────────────────────────────────────────────────────────

if [[ -t 1 ]]; then
  B=$'\e[1m'; R=$'\e[0m'; DIM=$'\e[2m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'
else
  B=''; R=''; DIM=''; GREEN=''; YELLOW=''; RED=''
fi

step() { printf '\n%s==>%s %s%s%s\n' "$GREEN" "$R" "$B" "$*" "$R"; }
info() { printf '    %s\n' "$*"; }
skip() { printf '    %salready done: %s%s\n' "$DIM" "$*" "$R"; }
warn() { printf '    %s! %s%s\n' "$YELLOW" "$*" "$R"; }
die()  { printf '\n%serror:%s %s\n' "$RED" "$R" "$*" >&2; exit 1; }
line() { printf '    %-46s %s\n' "$1" "$2"; }

# Reads a value with the echo off and will not take an empty answer.
ask_secret() {
  local prompt=$1 __out=$2 value=''
  while [[ -z $value ]]; do
    printf '    %s: ' "$prompt" >&2
    read -rs value
    printf '\n' >&2
  done
  printf -v "$__out" '%s' "$value"
}

ask() {
  local prompt=$1 __out=$2 fallback=${3-} value=''
  if [[ -n $fallback ]]; then printf '    %s [%s]: ' "$prompt" "$fallback" >&2
  else printf '    %s: ' "$prompt" >&2
  fi
  read -r value
  printf -v "$__out" '%s' "${value:-$fallback}"
}

confirm() {
  local answer=''
  printf '    %s [y/N] ' "$1" >&2
  read -r answer
  [[ $answer == [yY]* ]]
}

usage() {
  cat <<'USAGE'
usage: sudo bash deploy/install.sh [options]

  --check          Report what the host has and what would change. Changes nothing.
  --selftest       Generate the env file and the units into a temporary directory, validate
                   them, and delete them. Touches nothing real.
  --check-db       Ask for the two connection strings and test them: connect, authenticate,
                   and — for the migration string — create a type and roll it back. Writes
                   nothing, keeps nothing, and needs no root.
  --reconfigure    Ask the configuration questions again, keeping the old api.env beside it.
  --repo URL       Where to clone from. Defaults to the AVEX repository.
  --branch NAME    Branch to check out. Defaults to main.
  -h, --help       This.
USAGE
}

# ── is this host already busy? ───────────────────────────────────────────────
#
# The three ways a gateway install can damage a server that is already running something. None of
# them are hypothetical: a host reached by `ssh root@… pm2 restart <app>` has all three.

port_in_use() {
  local port=$1
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "sport = :$port" 2>/dev/null | grep -q .
  else
    # bash's own network redirection: a successful connect means somebody is listening.
    (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null && { exec 3<&-; return 0; }
    return 1
  fi
}

# Find a free loopback port, starting at 3000.
#
# This matters more than it looks. The old code hardcoded 3000 and then waited for
# `curl 127.0.0.1:3000/health` to answer — so on a host where something else already held 3000,
# our API would fail to bind, the *other* application would answer the health check, and the
# installer would report success and start the watcher against an API that was never running.
# Choosing a port that is provably free before anything starts removes the ambiguity rather than
# trying to tell the two apart afterwards.
pick_port() {
  local candidate=3000
  while port_in_use "$candidate"; do
    warn "port $candidate is already taken on this host"
    candidate=$(( candidate + 1 ))
    (( candidate < 3100 )) || die "no free port between 3000 and 3099"
  done
  API_PORT=$candidate
  [[ $API_PORT == 3000 ]] || info "the API will use port $API_PORT instead"
}

# Whatever is already terminating TLS.
#
# Installing Caddy in front of an nginx that already owns 443 gives a Caddy that cannot start and
# a site that still works, which is the confusing order to discover it in. So if something else
# is there, this writes a server block for it and changes nothing.
existing_web_server() {
  local name
  for name in nginx apache2 httpd caddy; do
    if systemctl is-active --quiet "$name" 2>/dev/null; then
      printf '%s' "$name"
      return
    fi
  done
}

# What the build needs, measured rather than guessed.
#
# `tsc -b` over this project peaks at about 573 MB of resident memory, and npm's own resolution
# adds a few hundred more. That is fine on a spare host and not obviously fine on a 2 GB box that
# is already running three applications and touching swap — which is the case this exists for.
readonly BUILD_PEAK_MB=573

# Available memory now, and whether the build is likely to fit in it.
#
# The danger is not a slow build. It is the kernel's OOM killer, which picks a victim by size and
# may well pick somebody's production process rather than the compiler that caused the shortage.
# So this reports the numbers and `sync_code` caps the compiler's heap, which turns a shortfall
# into a failed build instead of a killed application.
report_memory() {
  command -v free >/dev/null 2>&1 || return 0

  local available swap_free
  available=$( free -m | awk '/^Mem:/ {print $7}' )
  swap_free=$( free -m | awk '/^Swap:/ {print $4}' )
  [[ -n $available ]] || return 0

  info "memory: ${available}MB available, ${swap_free:-0}MB free swap"

  if (( available < BUILD_PEAK_MB )); then
    warn "the build peaks near ${BUILD_PEAK_MB}MB and only ${available}MB is available."
    warn "it will lean on swap. The compiler's heap is capped so a shortfall fails the build"
    warn "rather than letting the kernel pick one of this host's other processes to kill."
  fi
  return 0
}

# ── the host ─────────────────────────────────────────────────────────────────

detect_host() {
  if command -v systemd-analyze >/dev/null 2>&1; then
    SYSTEMD_VERSION=$(systemd-analyze --version 2>/dev/null | head -1 | grep -oE '[0-9]+' | head -1)
  fi

  # How the settlement key is delivered, decided from what systemd can do. The tiers are not
  # cosmetic: encrypted credentials need 250, plain ones — still a tmpfs visible only to the unit
  # — need 247. Ubuntu 22.04 ships 249, which is a default Hetzner image, so the middle tier is
  # the common case rather than a fallback nobody hits.
  if   (( SYSTEMD_VERSION >= 250 )); then KEY_MECHANISM=encrypted
  elif (( SYSTEMD_VERSION >= 247 )); then KEY_MECHANISM=credential
  else KEY_MECHANISM=file
  fi

  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node --version | tr -d 'v' | cut -d. -f1)
    NODE_BIN=$(command -v node)
  fi
}

# Everything already running that this install could disturb, reported before it does anything.
report_neighbours() {
  local server pm2_apps

  server=$(existing_web_server)
  [[ -n $server ]] && info "$server is running and already owns ports 80/443"

  if command -v pm2 >/dev/null 2>&1; then
    # sort -u because `pm2 jlist` carries each name twice, once at the top level and once inside
    # pm2_env, and the report read "trade-backend,trade-backend".
    pm2_apps=$( pm2 jlist 2>/dev/null | grep -o '"name":"[^"]*"' | cut -d'"' -f4 |
      sort -u | paste -sd', ' - )
    [[ -n $pm2_apps ]] && info "pm2 is running: $pm2_apps"
  fi

  report_memory

  port_in_use 3000 && warn "something already listens on port 3000"

  # Explicit, and not tidiness.
  #
  # The line above is an AND list, so on a host where port 3000 is *free* it evaluates to 1 — and
  # a function whose last statement returns 1 returns 1, which under `set -e` ends the script.
  # The symptom was --check printing the host and then stopping, with no error and exit 0.
  return 0
}

report_host() {
  step "Host"
  info "$( (source /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || echo 'unknown distribution' )"
  info "systemd $SYSTEMD_VERSION, so the settlement key goes in as: $B$KEY_MECHANISM$R"
  if (( NODE_MAJOR >= 22 )); then
    info "node $(node --version) at $NODE_BIN"
  else
    warn "node $( ((NODE_MAJOR)) && node --version || echo 'not installed' ) — this needs 22 or newer"
  fi
  for tool in git openssl curl; do
    command -v "$tool" >/dev/null 2>&1 || warn "$tool is missing"
  done
  command -v caddy >/dev/null 2>&1 ||
    warn "caddy is not installed — nothing would terminate TLS in front of the API"
}

report_check() {
  step "What would change"
  line "user $SERVICE_USER" \
    "$( id -u "$SERVICE_USER" >/dev/null 2>&1 && echo 'exists' || echo 'would be created' )"
  line "$APP_DIR" \
    "$( [[ -d $APP_DIR/.git ]] && echo 'exists, would be updated' || echo 'would be cloned' )"
  line "  from" "$REPO"
  line "  branch" "$BRANCH"
  line "$ENV_FILE" \
    "$( [[ -f $ENV_FILE ]] && echo 'exists, would be left alone' || echo 'would be written' )"
  line "settlement key" \
    "$( [[ -f $KEY_FILE || -f $KEY_CRED ]] && echo 'exists, would be left alone' || echo 'would be offered' )"
  line "$UNIT_DIR/avex-api.service" \
    "$( [[ -f $UNIT_DIR/avex-api.service ]] && echo 'would be rewritten' || echo 'would be written' )"
  line "$UNIT_DIR/avex-watcher.service" \
    "$( [[ -f $UNIT_DIR/avex-watcher.service ]] && echo 'would be rewritten' || echo 'would be written' )"
  printf '\n    %sNothing was changed. Run without --check to do it.%s\n\n' "$DIM" "$R"
}

# ── packages ─────────────────────────────────────────────────────────────────

apt_updated=0
apt_get() {
  (( apt_updated )) || { DEBIAN_FRONTEND=noninteractive apt-get update -qq; apt_updated=1; }
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
}

install_packages() {
  step "Packages"

  if ! command -v apt-get >/dev/null 2>&1; then
    warn "no apt-get here; install node 22+, git, curl and openssl yourself"
    (( NODE_MAJOR >= 22 )) || die "node 22 or newer is required"
    return
  fi

  local need=() tool
  for tool in git curl openssl ca-certificates gnupg; do
    command -v "$tool" >/dev/null 2>&1 || need+=("$tool")
  done
  if (( ${#need[@]} )); then
    info "installing: ${need[*]}"
    apt_get "${need[@]}"
  else
    skip "git, curl, openssl"
  fi

  if (( NODE_MAJOR >= 22 )); then
    skip "node $(node --version)"
    return
  fi

  # An older node, on a host that is running something with it.
  #
  # Replacing the system node under a live application is the kind of change that works until its
  # next restart. So it is a decision, taken by the person who knows what else is on the box, not
  # a step this script takes on their behalf.
  if (( NODE_MAJOR > 0 )); then
    warn "node $(node --version) is installed and this project needs 22."
    if command -v pm2 >/dev/null 2>&1 && pm2 jlist 2>/dev/null | grep -q '"name"'; then
      warn "pm2 is running applications on that node. Upgrading it changes what they run"
      warn "the next time they restart."
    fi
    confirm "Upgrade the system node to 22?" ||
      die "stopped. Install node 22 in a way that suits this host — nvm, a tarball in /opt, a
       container — and run this again; the units use whichever node is first on PATH."
  fi

  # NodeSource as an apt repository, with its key verified, rather than a piped installer script.
  # Ubuntu's own `nodejs` is 18 and this project needs 22.
  info "adding the NodeSource repository for node 22"
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
  chmod 0644 /usr/share/keyrings/nodesource.gpg
  echo 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' \
    > /etc/apt/sources.list.d/nodesource.list
  apt_updated=0
  apt_get nodejs
  hash -r
  NODE_MAJOR=$(node --version | tr -d 'v' | cut -d. -f1)
  NODE_BIN=$(command -v node)
  info "node $(node --version) at $NODE_BIN"
}

# ── user, directories, code ──────────────────────────────────────────────────

ensure_user() {
  step "Service user and directories"

  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    skip "user $SERVICE_USER"
  else
    useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
    info "created $SERVICE_USER, with no shell and no password"
  fi

  # 0750 root:avex — the service reads it, nobody else on the host can.
  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"
  install -d -m 0755 "$APP_DIR"
  info "$CONF_DIR is 0750 root:$SERVICE_USER"
}

sync_code() {
  step "Code"

  info "branch $BRANCH from $REPO"

  if [[ -d $APP_DIR/.git ]]; then
    info "updating $APP_DIR to $BRANCH"
    git -C "$APP_DIR" remote set-url origin "$REPO"
    git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
    git -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  else
    info "cloning $REPO ($BRANCH)"
    git clone --quiet --branch "$BRANCH" "$REPO" "$APP_DIR"
  fi
  info "at $(git -C "$APP_DIR" rev-parse --short HEAD)"

  # --include=dev is load-bearing: the build runs tsc, a devDependency, and a host with
  # NODE_ENV=production set makes plain `npm ci` skip it. The failure then arrives as a missing
  # module rather than as anything about environments.
  # A capped heap for both, and the cap is the point rather than a tuning knob.
  #
  # Unbounded, node grows until the kernel intervenes, and the OOM killer chooses its victim by
  # size across the whole host — so a compile that wanted one more hundred megabytes can end with
  # somebody's unrelated production process dead and no message connecting the two. Capped, the
  # same shortage is an "out of memory" from node, the build stops, and everything else on the
  # host is untouched.
  local heap_mb=$(( BUILD_PEAK_MB + 128 ))
  info "installing dependencies (heap capped at ${heap_mb}MB)"
  ( cd "$APP_DIR" && NODE_ENV=development NODE_OPTIONS="--max-old-space-size=$heap_mb" \
      npm ci --include=dev --silent )
  info "building"
  ( cd "$APP_DIR" && NODE_OPTIONS="--max-old-space-size=$heap_mb" \
      npm run build --workspace @avex/api --silent )
  chown -R "$SERVICE_USER" "$APP_DIR"
}

# ── configuration ────────────────────────────────────────────────────────────

# Why a string is unusable for migrations, or empty if it is fine.
#
# Caught at the prompt rather than at the migration, because the migration's own failure is the
# single most misleading error in this deployment: `CREATE TYPE` through a transaction-mode pooler
# fails looking like a syntax error inside the migration file, and the hour that follows is spent
# reading SQL that is correct. One string comparison here saves it.
#
# Pure and separate so the self-test can exercise it without a prompt.
direct_url_problem() {
  local url=$1
  case $url in
    *:6543/*|*:6543)
      printf '%s' 'it is the transaction pooler on port 6543'
      ;;
    *pgbouncer=true*)
      printf '%s' 'it carries pgbouncer=true, which marks a transaction pooler'
      ;;
  esac
}

ask_configuration() {
  cat <<'PROMPT'
    Nothing below is echoed except the addresses and domains.

    The direct database string must be the one on port 5432, not the pooler on
    6543: this schema creates enum types, and CREATE TYPE through a transaction
    pooler fails in a way that reads like a syntax error in the migration.

PROMPT

  ask_secret "DATABASE_URL (the pooler on 6543, or the direct one if you have only one)" db_url

  # Asked until it is usable. A wrong answer here is only discovered at the migration, several
  # minutes and one misleading error later.
  local problem
  while :; do
    ask_secret "DIRECT_DATABASE_URL (session or direct, port 5432 — never 6543)" direct_url
    problem=$(direct_url_problem "$direct_url")
    [[ -z $problem ]] && break
    warn "that cannot run migrations: $problem."
    warn "use the *direct* connection, or the *session* pooler — both keep one backend per"
    warn "connection, which is what CREATE TYPE needs. On Supabase both are on port 5432."
  done
  ask_secret "SMTP_URL, e.g. smtps://user:pass@smtp.example.net:465" smtp_url
  ask "MAIL_FROM" mail_from "no-reply@avexpay.net"
  ask "OPERATOR_EMAIL — where critical alerts go" operator_email
  ask "The public domain of the static pages" app_url "https://avexpay.net"
  ask "TRON JSON-RPC endpoint (blank to skip TRON)" tron_rpc "https://api.trongrid.io/jsonrpc"
}

# Single-quote a value for the environment file.
#
# Not cosmetic, and the reason is worth stating. systemd's `EnvironmentFile=` has its own parser
# and handles `KEY=value with spaces` correctly — but everything else that reads this file goes
# through the shell, because `set -a; . api.env` is how the migrations, the preflight and the
# admin bootstrap get their configuration, here and in the documentation.
#
# Unquoted, `MAIL_FROM_NAME=AVEX Pay` makes the shell run `Pay` as a command. That is the harmless
# version. A database password containing a semicolon or `$(...)` would be *executed* by the shell
# that sourced the file — an injection whose payload the operator pasted in themselves, which is
# the kind nobody thinks to look for. Both quoting styles are understood by systemd's parser too,
# so one form is correct everywhere.
#
# A literal single quote cannot be represented safely for both parsers at once, so it is refused
# rather than mangled. In a connection string it belongs percent-encoded as %27 anyway.
quote_env() {
  local value=$1
  if [[ $value == *"'"* ]]; then
    die "a configuration value contains a single quote, which cannot be written safely.
       Percent-encode it (%27) and run this again."
  fi
  printf "'%s'" "$value"
}

write_env_file() {
  local rpc_urls='' memo_secret
  [[ -n $tron_rpc ]] && rpc_urls="tron=$tron_rpc"
  memo_secret=$(openssl rand -hex 24)

  umask 077
  cat > "$ENV_FILE" <<ENVFILE
# Written by deploy/install.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ).
# Mode 0600, owned by $SERVICE_USER. Re-run with --reconfigure to change it.

# Every value is single-quoted. systemd's parser and the shell both understand
# that, and unquoted it would be the shell running part of a password.

NODE_ENV='production'
PORT='$API_PORT'
HOST='127.0.0.1'

DATABASE_URL=$(quote_env "$db_url")
DIRECT_DATABASE_URL=$(quote_env "$direct_url")

# The static pages, not the API: a verification link is APP_URL/dashboard and a
# payer's link is APP_URL/pay/<id>. Pointing this at the API host produces mail
# whose links 404.
APP_URL=$(quote_env "$app_url")

SMTP_URL=$(quote_env "$smtp_url")
MAIL_FROM=$(quote_env "$mail_from")
MAIL_FROM_NAME='AVEX Pay'
OPERATOR_EMAIL=$(quote_env "$operator_email")

CHECKOUT_ORIGINS=$(quote_env "$app_url")
DASHBOARD_ORIGINS=$(quote_env "$app_url")

# TRON serves an Ethereum-compatible JSON-RPC, which is why it lives here.
EVM_RPC_URLS=$(quote_env "$rpc_urls")

# Generated here, once. A memo is visible to anyone watching the shared wallet,
# so a guessable one would let a stranger claim someone else's payment.
MEMO_SECRET=$(quote_env "$memo_secret")

# EVM chains: fill these in after running contracts/deploy.mjs. Both halves of a
# chain or neither — a factory without its logic address derives addresses that
# nothing can ever settle.
# FORWARDER_FACTORIES=bsc=0x...
# FORWARDER_IMPLEMENTATIONS=bsc=0x...
# FEE_COLLECTORS=bsc=0x...
ENVFILE
  umask 022
  chown "$SERVICE_USER" "$ENV_FILE" 2>/dev/null || true
  chmod 0600 "$ENV_FILE"
}

configure() {
  step "Configuration"

  if [[ -f $ENV_FILE ]]; then
    if [[ $MODE == reconfigure ]]; then
      local backup="$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
      cp -p "$ENV_FILE" "$backup"
      warn "kept the old configuration at $backup"
    else
      skip "$ENV_FILE — pass --reconfigure to change it"
      return
    fi
  fi

  ask_configuration
  write_env_file
  unset db_url direct_url smtp_url
  info "wrote $ENV_FILE (0600, $SERVICE_USER)"
}

# ── the settlement key ───────────────────────────────────────────────────────

setup_key() {
  step "Settlement key"

  if [[ -f $KEY_FILE || -f $KEY_CRED ]]; then
    # Never regenerated: a new key is a new gas wallet, and the old one holds the balance.
    skip "a settlement key is already in place"
    return
  fi

  if ! confirm "Set up a settlement key now? Say no for a TRON-only launch — it needs none."; then
    info "skipped. Payments will be detected and credited; EVM funds stay at their deposit"
    info "addresses, where they can only ever pay their own merchant."
    return
  fi

  local key address
  key=$(openssl rand -hex 32)
  address=$( cd "$APP_DIR" && node --input-type=module -e '
    import { addressFromPrivateKey } from "./packages/core/dist/index.js";
    const hex = process.argv[1].replace(/^0x/, "");
    const bytes = Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16)));
    process.stdout.write(addressFromPrivateKey(bytes));
  ' "$key" )

  if [[ $KEY_MECHANISM == encrypted ]]; then
    printf '0x%s' "$key" | systemd-creds encrypt --name=settlement-key - "$KEY_CRED"
    chmod 0600 "$KEY_CRED"
    info "encrypted into $KEY_CRED — the plaintext never reached the disk"
  else
    umask 077
    printf '0x%s\n' "$key" > "$KEY_FILE"
    umask 022
    chown "$SERVICE_USER" "$KEY_FILE" 2>/dev/null || true
    chmod 0600 "$KEY_FILE"
    info "wrote $KEY_FILE (0600, $SERVICE_USER)"
  fi
  unset key

  printf "\n    %sFund this address with the chain's native token — it pays gas:%s\n" "$B" "$R"
  printf '      %s%s%s\n\n' "$B" "$address" "$R"
  info "It cannot redirect a merchant's money: a deposit address pays the destination"
  info "written into its own code. What it holds is the gas balance, so keep it to a"
  info "few days' worth and let the alerts watch it."
}

# What the watcher's unit should say about the key, from what is actually on disk.
key_directives() {
  if [[ -f $KEY_CRED ]]; then
    printf 'LoadCredentialEncrypted=settlement-key:%s\nEnvironment=SETTLEMENT_KEY_FILE=%%d/settlement-key' \
      "$KEY_CRED"
  elif [[ -f $KEY_FILE && $KEY_MECHANISM == credential ]]; then
    # %n is the full unit name; %N drops the .service suffix the directory keeps.
    printf 'LoadCredential=settlement-key:%s\nEnvironment=SETTLEMENT_KEY_FILE=/run/credentials/%%n/settlement-key' \
      "$KEY_FILE"
  elif [[ -f $KEY_FILE ]]; then
    printf 'Environment=SETTLEMENT_KEY_FILE=%s' "$KEY_FILE"
  fi
}

# ── the units ────────────────────────────────────────────────────────────────

# The fourth argument decides whether this unit gets the settlement key. Only the watcher does:
# it is the process that settles, and the API no longer builds a signer at all. Handing the key
# to both would double the number of processes a gas wallet could be drained from, for nothing.
write_unit() {
  local name=$1 description=$2 entry=$3 wants_key=${4:-without-key} credentials=''
  [[ $wants_key == with-key ]] && credentials=$(key_directives)

  cat > "$UNIT_DIR/$name" <<UNIT
# Written by deploy/install.sh. Re-run it to regenerate.
[Unit]
Description=$description
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
WorkingDirectory=$APP_DIR/apps/api
EnvironmentFile=$ENV_FILE
$credentials
ExecStart=$NODE_BIN $entry
Restart=always
RestartSec=5

# It needs its own code and the network, and nothing else.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
  info "wrote $UNIT_DIR/$name"
}

write_units() {
  step "Services"
  install -d -m 0755 "$UNIT_DIR"
  write_unit avex-api.service     'AVEX Pay API'           dist/main.js    without-key
  write_unit avex-watcher.service 'AVEX Pay chain watcher' dist/watcher.js with-key
}

# ── TLS ──────────────────────────────────────────────────────────────────────

setup_tls() {
  step "TLS"

  local server domain host
  server=$(existing_web_server)
  domain=$( grep -oP "(?<=^APP_URL=').*(?=')" "$ENV_FILE" | sed 's|https\?://||' )

  if [[ -n $server && $server != caddy ]]; then
    # Something else already owns 443. Writing a Caddyfile here would give a Caddy that cannot
    # bind and a site that still works, which is a confusing order to find out in.
    ask "The hostname the API should answer on" host "api.${domain:-avexpay.net}"
    local snippet="$CONF_DIR/$server-api.conf"
    cat > "$snippet" <<PROXY
# Written by deploy/install.sh for $server, which is already serving this host.
#
# Include it from your $server configuration and reload. The API listens on loopback only, so
# this is the only way in, and the certificate is $server's business rather than ours.

server {
    server_name $host;
    listen 443 ssl;

    location / {
        proxy_pass         http://127.0.0.1:$API_PORT;
        proxy_http_version 1.1;
        proxy_set_header   Host \$host;
        proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
    }
}
PROXY
    info "$server already owns 443, so nothing here was changed."
    info "a server block for it is at $snippet — include it and reload $server."
    info "point an A record for $host at this host, and give $server a certificate for it."
    return
  fi

  if ! command -v caddy >/dev/null 2>&1; then
    warn "caddy is not installed, so nothing terminates TLS."
    warn "install it, or put any reverse proxy in front of 127.0.0.1:3000."
    return
  fi

  if [[ -f $CADDY_FILE ]] && grep -q "reverse_proxy 127.0.0.1:$API_PORT" "$CADDY_FILE"; then
    skip "the Caddyfile already proxies to the API"
    return
  fi

  ask "The hostname Caddy should serve the API on" host "api.${domain:-avexpay.net}"

  install -d -m 0755 "$(dirname "$CADDY_FILE")"
  cat > "$CADDY_FILE" <<CADDY
# Written by deploy/install.sh.
#
# The API listens on 127.0.0.1 only, so this is the only way in and TLS is not optional.
$host {
  reverse_proxy 127.0.0.1:$API_PORT
}
CADDY
  info "wrote $CADDY_FILE for $host"
  systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null ||
    warn "start caddy yourself: systemctl enable --now caddy"
  info "point an A record for $host at this host's IP; Caddy gets the certificate itself"
}

# ── database, preflight, start ───────────────────────────────────────────────

# Runs a workspace script with the configuration loaded, and without it leaking into this shell.
with_env() {
  ( cd "$APP_DIR" && set -a && . "$ENV_FILE" && set +a && "$@" )
}

migrate() {
  step "Database"

  local output status
  set +e
  output=$( with_env npm run db:migrate --workspace @avex/api 2>&1 )
  status=$?
  set -e

  if (( status == 0 )); then
    info "migrations applied"
    return
  fi

  printf '%s\n' "$output" | tail -20
  die "migrations failed. Two causes account for almost all of it.

       A transaction pooler in DIRECT_DATABASE_URL: CREATE TYPE cannot run through one and fails
       looking like a syntax error in the migration file. The prompt now refuses port 6543, so
       this is only reachable by editing api.env by hand.

       No route to the host: a Supabase project's *direct* endpoint resolves to IPv6 only unless
       the IPv4 add-on is enabled, and a server without working outbound IPv6 cannot reach it —
       the error is a timeout or 'network unreachable' rather than anything about addresses. The
       fix is the *session* pooler on port 5432, which is reachable over IPv4 and, being session
       mode, runs CREATE TYPE perfectly well. Check with:
           curl -6 -sS --max-time 5 https://supabase.com >/dev/null && echo 'IPv6 works'"
}

PREFLIGHT_STATUS=0
run_preflight() {
  step "Preflight"
  info "what this deployment cannot do, from its configuration alone:"
  printf '\n'
  set +e
  with_env npm run preflight --workspace @avex/api --silent 2>&1 | sed 's/^/    /'
  PREFLIGHT_STATUS=${PIPESTATUS[0]}
  set -e
}

start_services() {
  step "Starting"
  systemctl daemon-reload

  # The API first, and once. The curated asset catalogue — USDT on TRON and the rest — is written
  # when the API starts and only read by the watcher, so a watcher started first on a fresh
  # database has an approved, listed nothing to look for. It refuses to start and says why, which
  # is correct and baffling if you do not know the order.
  systemctl enable --now avex-api.service
  info "avex-api starting; waiting for it to answer"

  local healthy=0 _
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done

  if ! (( healthy )); then
    warn "the API did not answer within 30 seconds. Its log:"
    journalctl -u avex-api.service -n 25 --no-pager | sed 's/^/      /'
    warn "the watcher was not started, because it needs the API to have run once."
    return
  fi

  info "the API answers on 127.0.0.1:$API_PORT"
  systemctl enable --now avex-watcher.service
  sleep 3
  if systemctl is-active --quiet avex-watcher.service; then
    info "the watcher is running"
  else
    warn "the watcher is not running. Its own log says why:"
    journalctl -u avex-watcher.service -n 15 --no-pager | sed 's/^/      /'
  fi
}

bootstrap_admin() {
  step "Admin account"

  if ! confirm "Create the first admin account now? It can only ever be done once."; then
    info "later: cd $APP_DIR && set -a; . $ENV_FILE; set +a"
    info "       npm run admin:bootstrap --workspace @avex/api"
    return
  fi

  printf '\n'
  with_env npm run admin:bootstrap --workspace @avex/api --silent ||
    warn "that did not complete. Run it again with the two lines above."
}

summary() {
  step "Done, and what is left for you"
  local pages
  pages=$( grep -oP "(?<=^APP_URL=').*(?=')" "$ENV_FILE" 2>/dev/null || echo 'https://avexpay.net' )
  cat <<NEXT
    Nothing above needed a browser. These do:

      1. Sign in at $pages/dashboard, create a merchant, and register three to five
         TRON deposit wallets. The keys stay with you; we only ever hold addresses.
      2. Make one invoice and pay it with a real wallet, for a small amount:
             journalctl -u avex-watcher -f
      3. Then the same from a phone, scanning the QR with a real camera.

    Afterwards:

      systemctl status avex-api avex-watcher
      journalctl -u avex-watcher -f
      sudo bash $APP_DIR/deploy/install.sh                # pick up a new commit
      sudo bash $APP_DIR/deploy/install.sh --reconfigure   # change the configuration

NEXT
}

# ── self-test ────────────────────────────────────────────────────────────────
#
# Generates the two files that break a deployment when they are wrong — the environment file and
# the units — into a temporary directory, checks them, and deletes them. It touches nothing real.
#
# Worth having because these are the parts of this script whose mistakes are silent: a unit with a
# bad directive fails at `systemctl start` with a message about the unit rather than about what is
# wrong, and an environment file missing one key fails at boot inside zod.

# Names of the checks that failed, so they are readable at the end instead of scrolled off.
FAILED_CHECKS=()
note_failure() { FAILED_CHECKS+=("$1"); }

# What `systemd-analyze verify` says about a unit's *directives*, with the host-specific parts
# neutralised first.
#
# Filtering the analyzer's complaints by message text was the previous approach and it was
# fragile: the wording for an unresolvable user or a missing binary differs between systemd
# versions, so a real finding on one host was filtered on another and a filtered artefact on one
# was reported as a failure on the next. This instead verifies a copy in which the three things
# that legitimately do not resolve yet are replaced by things that always do — the service user
# does not exist until a later step, the working directory is created by that step, and node may
# be anywhere. What is left is the syntax and the directive names, which is the whole point of
# the check.
#
# `2>&1` and a captured variable, not a pipe: the analyzer exits non-zero whenever it has anything
# to say, and under `set -o pipefail` a pipeline ending in `grep -q` inherits that, which is how
# this check once reported every unit as valid including a deliberately broken one.
verify_unit() {
  local unit=$1 dir neutral
  # A directory, because the copy has to keep a valid unit *name*: `systemd-analyze verify` will
  # not look at a file whose name is not `<something>.service`, and refuses with "Failed to
  # prepare filename … Invalid argument", which reads like a problem with the unit.
  dir=$(mktemp -d)
  neutral="$dir/$(basename "$unit")"

  sed -e 's|^User=.*|User=root|' \
      -e 's|^WorkingDirectory=.*|WorkingDirectory=/tmp|' \
      -e 's|^ExecStart=.*|ExecStart=/bin/true|' \
      -e '/^LoadCredential/d' \
      "$unit" > "$neutral"

  local output
  output=$( systemd-analyze verify "$neutral" 2>&1 || true )
  rm -rf "$dir"

  printf '%s' "$output" | grep -v '^[[:space:]]*$' || true
}

# The messages that mean the unit is actually wrong, as systemd words them.
#
# A positive list, and the inversion matters. Filtering out the artefacts and failing on whatever
# was left made every unrecognised message fatal — so a newer systemd saying something new about a
# perfectly good unit blocked the install, which is what happened on 259 after 255 was silent. A
# list of the defects we care about fails on those and treats anything else as advisory: worth
# printing, not worth stopping for.
#
# These five cover every way a unit file can be wrong rather than merely unusual, and each was
# taken from systemd's own output rather than guessed:
#
#   Unknown key name 'Bogus' in section 'Service', ignoring.
#   Unknown section 'Servce'. Ignoring.
#   Failed to parse service restart specifier, ignoring: alwayss
#   Unit b.service has a bad unit file setting.
#   Service has no ExecStart=, ExecStop=, or SuccessAction=. Refusing.
readonly UNIT_DEFECTS='Unknown key name|Unknown section|Failed to parse|bad unit file setting|Refusing'

selftest() {
  local root failures=0
  root=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$root'" EXIT

  AVEX_ROOT="$root"
  APP_DIR="$root/opt/avex"
  CONF_DIR="$root/etc/avex"
  ENV_FILE="$CONF_DIR/api.env"
  KEY_FILE="$CONF_DIR/settlement-key"
  KEY_CRED="$CONF_DIR/settlement-key.cred"
  UNIT_DIR="$root/etc/systemd/system"

  install -d -m 0750 "$CONF_DIR"
  install -d -m 0755 "$UNIT_DIR"

  step "Self-test"
  info "building into $root"

  db_url='postgres://u:p@db.example:6543/postgres'
  direct_url='postgres://u:p@db.example:5432/postgres'
  smtp_url='smtps://u:p@smtp.example:465'
  mail_from='no-reply@avexpay.net'
  operator_email='ops@avexpay.net'
  app_url='https://avexpay.net'
  tron_rpc='https://api.trongrid.io/jsonrpc'

  write_env_file

  local check
  # Every key the API refuses to boot without, plus the two whose absence is silent.
  for check in NODE_ENV PORT HOST DATABASE_URL DIRECT_DATABASE_URL APP_URL SMTP_URL MAIL_FROM \
               OPERATOR_EMAIL CHECKOUT_ORIGINS DASHBOARD_ORIGINS EVM_RPC_URLS MEMO_SECRET; do
    if grep -q "^$check='" "$ENV_FILE"; then
      line "$check" 'present'
    else
      line "$check" 'MISSING'
      note_failure "a required key is missing from api.env"; failures=$(( failures + 1 ))
    fi
  done

  # The real test: does the API's own configuration schema accept this file?
  #
  # Everything above is a list of key names, and a list is a thing that goes stale the first time
  # somebody adds a required variable. `loadEnv` is the function that will actually reject the
  # file at boot, so asking it directly is the only check that cannot drift.
  if [[ -f $REPO_ROOT/apps/api/dist/env.js ]]; then
    local verdict
    set +e
    verdict=$( cd "$REPO_ROOT" && env -i \
      "PATH=$PATH" \
      bash -c "set -a; . '$ENV_FILE'; set +a; exec node --input-type=module -e '
        import { loadEnv } from \"./apps/api/dist/env.js\";
        const env = loadEnv();
        process.stdout.write(\"accepted, and settles: \" + (env.SETTLEMENT_KEY_FILE !== undefined));
      '" 2>&1 )
    local status=$?
    set -e
    if (( status == 0 )); then
      line 'loadEnv on the generated file' "$verdict"
    else
      line 'loadEnv on the generated file' 'REJECTED:'
      printf '%s\n' "$verdict" | sed 's/^/        /'
      note_failure "the generated api.env is rejected by loadEnv"; failures=$(( failures + 1 ))
    fi
  else
    line 'loadEnv on the generated file' 'skipped — build the API first to check this'
  fi

  local mode
  mode=$(stat -c '%a' "$ENV_FILE")
  if [[ $mode == 600 ]]; then line 'api.env mode' '0600'
  else line 'api.env mode' "$mode, should be 600"; note_failure "api.env is not mode 0600"; failures=$(( failures + 1 ))
  fi

  if [[ $(grep -c "^MEMO_SECRET='.\{40,\}'" "$ENV_FILE") == 1 ]]; then
    line 'MEMO_SECRET' 'generated, long enough'
  else
    line 'MEMO_SECRET' 'too short or missing'; note_failure "MEMO_SECRET is too short"; failures=$(( failures + 1 ))
  fi

  # The bug this file used to have, asserted so it cannot come back.
  #
  # An unquoted value with a space made the shell run the second word as a command; the same flaw
  # with a `;` or a `$(...)` in a password would have executed it. So the check is not "does it
  # parse" but "does a hostile value survive a round trip through the shell unchanged".
  local nasty="pa ss;word \$(echo pwned)\`echo also\` &|<>*?"
  local previous_smtp=$smtp_url
  smtp_url="smtps://user:$nasty@smtp.example:465"
  write_env_file
  local round_trip
  round_trip=$( set -a; . "$ENV_FILE"; set +a; printf '%s' "$SMTP_URL" )
  if [[ $round_trip == "smtps://user:$nasty@smtp.example:465" ]]; then
    line 'a password full of shell metacharacters' 'survives sourcing unchanged'
  else
    line 'a password full of shell metacharacters' 'MANGLED OR EXECUTED:'
    printf '        got: %s\n' "$round_trip"
    note_failure "a shell metacharacter in a password is mangled"; failures=$(( failures + 1 ))
  fi
  smtp_url=$previous_smtp
  write_env_file

  # A key on disk, so the watcher's unit gets the directives a real run would give it.
  printf '0x%064d\n' 1 > "$KEY_FILE"
  chmod 0600 "$KEY_FILE"
  write_units

  local unit
  for unit in avex-api.service avex-watcher.service; do
    if ! command -v systemd-analyze >/dev/null 2>&1; then
      line "$unit" 'written (systemd-analyze is not here to check it)'
      continue
    fi

    local complaints defects advisories
    complaints=$( verify_unit "$UNIT_DIR/$unit" )
    defects=$(    printf '%s' "$complaints" | grep -E  "$UNIT_DEFECTS" || true )
    advisories=$( printf '%s' "$complaints" | grep -vE "$UNIT_DEFECTS" | grep -v '^$' || true )

    if [[ -n $defects ]]; then
      line "$unit" 'has a real defect:'
      printf '%s\n' "$defects" | sed 's/^/        /'
      # The text goes in the ledger too, because on a long run this line scrolls off and a name
      # alone is not something anybody can act on.
      note_failure "$unit: $(printf '%s' "$defects" | head -1)"
      failures=$(( failures + 1 ))
    elif [[ -n $advisories ]]; then
      # This systemd has something to say that is not a defect. Said, not failed on.
      line "$unit" 'valid, with notes from systemd:'
      printf '%s\n' "$advisories" | sed 's/^/        /'
    else
      line "$unit" 'valid'
    fi
  done

  # The one prompt whose wrong answer is expensive.
  local case_url problem
  for case_url in \
    'postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:6543/postgres' \
    'postgres://u:p@host:5432/postgres?pgbouncer=true'; do
    problem=$(direct_url_problem "$case_url")
    if [[ -n $problem ]]; then
      line 'a transaction pooler is refused for migrations' "${problem:0:44}"
    else
      line 'a transaction pooler is refused for migrations' 'NO — it would be accepted'
      note_failure 'a transaction pooler would be accepted as DIRECT_DATABASE_URL'
      failures=$(( failures + 1 ))
    fi
  done
  for case_url in \
    'postgres://u:p@db.abcdefgh.supabase.co:5432/postgres' \
    'postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres'; do
    if [[ -z $(direct_url_problem "$case_url") ]]; then
      line 'a session or direct string is accepted' "${case_url##*@}"
    else
      line 'a session or direct string is accepted' 'NO — it would be rejected'
      note_failure 'a usable DIRECT_DATABASE_URL would be rejected'
      failures=$(( failures + 1 ))
    fi
  done

  # The port has to reach every place that mentions it.
  #
  # It used to be the literal 3000 in the env file, in the Caddyfile and in the health check, so
  # picking a different one would have started an API on one port and waited on another.
  API_PORT=3777
  write_env_file
  if grep -q "^PORT='3777'" "$ENV_FILE"; then
    line 'the chosen port reaches api.env' '3777'
  else
    line 'the chosen port reaches api.env' "NO: $(grep '^PORT=' "$ENV_FILE")"
    note_failure "the chosen port does not reach api.env"; failures=$(( failures + 1 ))
  fi
  API_PORT=3000
  write_env_file

  # And the quoted values are still readable by the code that reads them back.
  local read_back
  read_back=$( grep -oP "(?<=^APP_URL=').*(?=')" "$ENV_FILE" )
  if [[ $read_back == "$app_url" ]]; then
    line 'APP_URL reads back out of the quotes' "$read_back"
  else
    line 'APP_URL reads back out of the quotes' "NO: got '$read_back'"
    note_failure "APP_URL cannot be read back out of its quotes"; failures=$(( failures + 1 ))
  fi

  # An absolute ExecStart, asserted directly.
  #
  # systemd will search a fixed list of directories for a bare command name, so a relative one
  # sometimes works and sometimes does not depending on where node was installed — which is the
  # worst of both. The selftest cannot check that the path exists, because it may be running on a
  # different machine than the unit will, so it checks the part that is knowable here.
  local exec_line
  exec_line=$( grep -h '^ExecStart=' "$UNIT_DIR/avex-api.service" | head -1 )
  if [[ ${exec_line#ExecStart=} == /* ]]; then
    line 'ExecStart is an absolute path' "${exec_line#ExecStart=}"
  else
    line 'ExecStart is an absolute path' "NO: $exec_line"
    note_failure "ExecStart is not an absolute path"; failures=$(( failures + 1 ))
  fi

  # The one asymmetry that matters, asserted rather than assumed.
  if grep -q 'SETTLEMENT_KEY_FILE' "$UNIT_DIR/avex-watcher.service"; then
    line 'the watcher gets the key' 'yes'
  else
    line 'the watcher gets the key' 'NO — it cannot settle'; note_failure "the watcher would not get the settlement key"; failures=$(( failures + 1 ))
  fi
  if grep -q 'SETTLEMENT_KEY_FILE' "$UNIT_DIR/avex-api.service"; then
    line 'the API is kept away from it' 'NO — it has the key and does not need it'
    note_failure "the API would be given the settlement key"; failures=$(( failures + 1 ))
  else
    line 'the API is kept away from it' 'yes'
  fi

  printf '\n'
  if (( failures )); then
    # Listed again here, because on a long run the failing lines have scrolled off the top and
    # "2 problem(s)" is not something anybody can act on.
    printf '    %swhat failed:%s\n' "$B" "$R"
    local failed
    for failed in "${FAILED_CHECKS[@]}"; do
      printf '      - %s\n' "$failed"
    done
    die "$failures problem(s) above. Nothing real was touched."
  fi
  info "${GREEN}everything the script generates is well-formed.${R} Nothing real was touched."
  printf '\n'
}

# ── the database, before anything depends on it ──────────────────────────────
#
# Separate from the install so it can be run first, and repeatedly, while a connection string is
# still being worked out. Needs no root and writes nothing.
#
# Worth its own mode because "is the database reachable" is the question everything else waits on,
# and the way it fails is not obvious: a transaction pooler answers `select 1` perfectly and then
# cannot run a migration, and a Supabase direct endpoint on an IPv4-only host hangs rather than
# refusing. Finding that out here costs seconds; finding it out at the migration costs an hour of
# reading correct SQL.

check_db() {
  local probe="$REPO_ROOT/deploy/check-db.mjs"
  [[ -f $probe ]] || die "cannot find $probe — run this from a checkout of the repository."
  command -v node >/dev/null 2>&1 || die "node is needed for this check; install it first."
  [[ -d $REPO_ROOT/node_modules/postgres ]] ||
    die "the postgres driver is not installed. Run: cd $REPO_ROOT && npm ci --include=dev"

  step "Database connection"
  local pooled direct problem status=0

  ask_secret "DATABASE_URL (transaction pooler, port 6543)" pooled
  printf '\n'
  ( cd "$REPO_ROOT" && node "$probe" pooled "$pooled" ) || status=1

  printf '\n'
  while :; do
    ask_secret "DIRECT_DATABASE_URL (session or direct, port 5432 — never 6543)" direct
    problem=$(direct_url_problem "$direct")
    [[ -z $problem ]] && break
    warn "that cannot run migrations: $problem."
  done
  printf '\n'
  ( cd "$REPO_ROOT" && node "$probe" direct "$direct" ) || status=1

  unset pooled direct
  printf '\n'
  if (( status == 0 )); then
    info "${GREEN}both strings work.${R} Nothing was written — run the installer to use them."
  else
    warn "fix the above and run this again. Nothing was written."
  fi
  return "$status"
}

# ── main ─────────────────────────────────────────────────────────────────────

main() {
  while [[ $# -gt 0 ]]; do
    case $1 in
      --check)       MODE=check; shift ;;
      --check-db)    MODE=check-db; shift ;;
      --selftest)    MODE=selftest; shift ;;
      --reconfigure) MODE=reconfigure; shift ;;
      --repo)        REPO=${2:?--repo needs a URL}; shift 2 ;;
      --branch)      BRANCH=${2:?--branch needs a name}; shift 2 ;;
      -h|--help)     usage; exit 0 ;;
      *)             usage >&2; die "unknown option: $1" ;;
    esac
  done

  detect_host

  if [[ $MODE == selftest ]]; then
    selftest
    exit 0
  fi

  if [[ $MODE == check-db ]]; then
    check_db
    exit $?
  fi

  [[ $EUID -eq 0 ]] ||
    die "run this with sudo: it creates a user, writes to /etc and installs units."

  report_host
  report_neighbours

  if [[ $MODE == check ]]; then
    report_check
    exit 0
  fi

  pick_port
  install_packages
  ensure_user
  sync_code
  configure
  setup_key
  write_units
  setup_tls
  migrate
  run_preflight
  start_services
  bootstrap_admin
  summary

  exit "$PREFLIGHT_STATUS"
}

main "$@"
