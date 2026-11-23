#!/usr/bin/env bash
# A REAL lila (Lichess's own server code) on the CI runner, for the chess load harness's LOAD_LICHESS=lila backend
# (e2e/load/chess-30-boards.load.ts header, load.yml `lichess: lila`). Needs Docker, so it runs in GitHub Actions only.
# It never talks to lichess.org: lila, its MongoDB and its Redis all run in one container on the runner's localhost.
#
#   lila-up.sh up     pull lila-docker's prebuilt mono image, turn PRODUCTION rate limits ON (the image ships
#                     `net.ratelimit = false`, conf/mono.conf:11), boot it, wait for HTTP, and mint LILA_ACCOUNT_COUNT
#                     fresh users with one personal token each, scoped EXACTLY to the product's play grant
#                     (lib/oauth.ts LICHESS_OAUTH_SCOPES). No user is an API hog and no user follows another, so a
#                     challenge costs what production charges: 5 credits, 25 a minute and 200 a day per challenger
#                     (lila Challenge.scala:308, Limiters.scala:92-98). Then it PROVES the limiter live (the canary
#                     below) and refuses to hand over a lila whose limiter is off.
#   lila-up.sh logs   after the run: lila's log, sanitised, and the ratelimit lines pulled out of it. At least one is
#                     owed (the canary's refusal), so zero fails: a lila that logged no refusal enforced none.
#
# The recipe, the token shape and every trap are the 2026-11-22 spike's (.superpowers/sdd/2026-11-17-chess-external-play/
# lila-spike-report.md, branch spike/lila-ci): a token is found by `_id = sha256(plaintext)` in `oauth2_access_token`
# (lila AccessToken.scala:48) and lila takes a freshly inserted one without a restart.
#
# Env (up):   LILA_ACCOUNT_COUNT  accounts to mint (LOAD_BOARDS x 2)
#             LILA_ACCOUNTS       where to write them: a JSON array of {id, token, scopes}. It holds TOKENS: keep it out of
#                                 every artifact (load.yml writes it under RUNNER_TEMP, never under load-out/).
#             LILA_OUT            a directory for the sanitised facts of the boot (uploaded with the report)
#             LILA_IMAGE          optional, default LILA_IMAGE_PINNED below. `ghcr.io/lichess-org/lila-docker:main` is
#                                 an explicit opt-in (it is rebuilt daily from lila master).
# Env (logs): LILA_OUT
#
# Every token is `::add-mask::`ed the moment it exists, and nothing written to LILA_OUT may carry one: every lip_ string
# is rewritten to lip_*** (lila's 400 for a bad bulk-pairing token ECHOES the token as a JSON key - never log a body raw).
set -euo pipefail

MODE="${1:-}"
OUT="${LILA_OUT:?LILA_OUT is required}"
NAME=lichess
BASE=http://localhost:8080
mkdir -p "$OUT"
san() { sed -E 's/lip_[A-Za-z0-9_-]+/lip_***/g'; }

if [ "$MODE" = "logs" ]; then
  if ! docker inspect "$NAME" > /dev/null 2>&1; then echo "no $NAME container: nothing to collect"; exit 0; fi
  docker logs -t "$NAME" 2>&1 | san > "$OUT/lila.log"
  grep -ai 'ratelimit' "$OUT/lila.log" > "$OUT/ratelimit.log" || true
  # supervisord restarts a crashed lila AND re-runs reset-db.sh (--drop-db): the minted users and the in-process rate-limit
  # counters would both be gone. More than one "Listening for HTTP" says it happened.
  boots=$(grep -aci 'listening for http' "$OUT/lila.log" || true)
  echo "lila HTTP boots in the log: $boots (1 expected); ratelimit lines: $(wc -l < "$OUT/ratelimit.log")"
  if [ "${boots:-0}" != "1" ]; then echo "::warning::lila booted $boots times during the run (a restart reseeds the DB and clears the rate-limit counters)"; fi
  lines="$(wc -l < "$OUT/ratelimit.log" | tr -d ' ')"
  echo "{\"httpBoots\": ${boots:-0}, \"ratelimitLines\": $lines}" > "$OUT/after-run.json"
  # `up`'s canary is refused before any player plays, so a lila that enforced its limiter logged at least that refusal.
  if [ "$lines" -lt 1 ]; then
    echo "::error::lila logged no ratelimit line all run, not even the limiter canary's refusal: its limiter was not enforcing"; exit 1
  fi
  exit 0
fi

if [ "$MODE" != "up" ]; then echo "usage: lila-up.sh up|logs" >&2; exit 2; fi

# lila-docker's mono image, pinned by digest so every dispatch, and both legs of one, run the same lila. This one is lila
# b071608b (2026-11-22): the spike's limits-on/off control and both recorded load runs ran on it. To bump: `docker pull
# ghcr.io/lichess-org/lila-docker:main`, read `docker image inspect <it> --format '{{index .RepoDigests 0}}'`, put that
# digest here, and dispatch one 8-board lila run - `up`'s limiter canary below must still see its 429 on the new image.
LILA_IMAGE_PINNED="ghcr.io/lichess-org/lila-docker@sha256:02107aadac516b356e2717f2f7aca896c4f825dc7c50366e6042e8562caf3269"

N="${LILA_ACCOUNT_COUNT:?LILA_ACCOUNT_COUNT is required}"
ACC="${LILA_ACCOUNTS:?LILA_ACCOUNTS is required}"
IMG="${LILA_IMAGE:-$LILA_IMAGE_PINNED}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/lila.XXXXXX")"
# The only plaintext tokens on disk under WORK. Gone on ANY exit, a failed mint or canary included (mono.conf stays: the
# running lila has it mounted).
trap 'rm -f "$WORK/accounts.ndjson"' EXIT
if ! [[ "$N" =~ ^[1-9][0-9]*$ ]] || [ "$N" -gt 9999 ]; then echo "::error::LILA_ACCOUNT_COUNT=$N is not a count of 1-9999"; exit 1; fi

# The play grant, read from the one place the product states it. The harness asserts every minted grant equals playScopes().
SCOPES="$(sed -nE 's/^export const LICHESS_OAUTH_SCOPES = "([^"]+)".*/\1/p' "$ROOT/apps/web/src/lib/oauth.ts")"
if [ -z "$SCOPES" ]; then echo "::error::LICHESS_OAUTH_SCOPES not found in apps/web/src/lib/oauth.ts"; exit 1; fi
SCOPES_JSON="$(printf '%s\n' $SCOPES | jq -R . | jq -sc .)"

T_PULL0=$(date +%s)
docker pull -q "$IMG" > /dev/null
T_PULL1=$(date +%s)

# Production rate limits ON: the image's mono.conf with its `net.ratelimit = false` line replaced by `true`, mounted over it.
docker run --rm --entrypoint cat "$IMG" /lila/conf/mono.conf > "$WORK/mono.conf.orig"
{ grep -av '^net.ratelimit' "$WORK/mono.conf.orig"; echo 'net.ratelimit = true'; } > "$WORK/mono.conf"
if [ "$(grep -ac '^net.ratelimit' "$WORK/mono.conf")" != "1" ] || ! grep -aqx 'net.ratelimit = true' "$WORK/mono.conf"; then
  echo "::error::the effective mono.conf does not set exactly net.ratelimit = true"; exit 1
fi

T_RUN=$(date +%s)
docker run -d --name "$NAME" -p 8080:8080 -v "$WORK/mono.conf:/lila/conf/mono.conf:ro" "$IMG" > /dev/null
READY=""
for _ in $(seq 1 200); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/user/ana" || true)"
  if [ "$code" = "200" ]; then READY=$(date +%s); break; fi
  sleep 3
done
if [ -z "$READY" ]; then
  echo "::error::lila never answered /api/user/ana within 10 minutes"
  docker logs -t "$NAME" 2>&1 | san | tail -80
  exit 1
fi
# What lila actually read, not what we meant to mount.
EFFECTIVE="$(docker exec "$NAME" grep -a '^net.ratelimit' /lila/conf/mono.conf || true)"
if [ "$EFFECTIVE" != "net.ratelimit = true" ]; then echo "::error::lila's mono.conf reads '$EFFECTIVE', not net.ratelimit = true"; exit 1; fi

# Mint: ids szl0001.. for the players, then the canary's pair (szlcanary challenges szlcanarydest), all through ONE clone -
# so the canary's 429 also witnesses that a minted account is no API hog and is followed by no one (either makes a create
# cost 0, and a 0-cost create is never refused). A random token each, masked at once, hashed here so the container only
# ever sees the sha256. The canary's pair never enters the accounts file: no player is a canary account.
CANARY=szlcanary
CANARY_DEST=szlcanarydest
CANARY_TOK=""
: > "$WORK/rows.js"
: > "$WORK/accounts.ndjson"
for i in $(seq 1 $((N + 2))); do
  if [ "$i" -le "$N" ]; then id="$(printf 'szl%04d' "$i")"; elif [ "$i" -eq $((N + 1)) ]; then id="$CANARY"; else id="$CANARY_DEST"; fi
  tok="lip_$(openssl rand -hex 20)"
  echo "::add-mask::$tok"
  hash="$(printf '%s' "$tok" | sha256sum | cut -d' ' -f1)"
  echo "  ['$id', '$hash']," >> "$WORK/rows.js"
  if [ "$id" = "$CANARY" ]; then CANARY_TOK="$tok"; fi
  if [ "$i" -le "$N" ]; then
    jq -nc --arg id "$id" --arg token "$tok" --argjson scopes "$SCOPES_JSON" '{id: $id, token: $token, scopes: $scopes}' >> "$WORK/accounts.ndjson"
  fi
done
MINT_N=$((N + 2))
if [ "$(wc -l < "$WORK/accounts.ndjson" | tr -d ' ')" != "$N" ] || [ -z "$CANARY_TOK" ]; then echo "::error::the mint list is not $N players plus the canary"; exit 1; fi
{
  echo "const scopes = $SCOPES_JSON;"
  echo "const rows = ["
  cat "$WORK/rows.js"
  echo "];"
  cat <<'JS'
// A clone of the seed's `zerogames` user (lila-db-seed user.py _create_special_users: no perfs, no roles, no marks), with a new
// id: the shape lila itself reads, and nothing seeded hangs off a fresh id (no follows, no user_perf, no history).
const tpl = db.user4.findOne({ _id: 'zerogames' });
if (!tpl) throw new Error('the seed has no zerogames user to clone');
const ptpl = db.pref.findOne({ _id: 'zerogames' }) || {};
const now = new Date();
const users = rows.map(([id]) => {
  const u = Object.assign({}, tpl, { _id: id, username: id, email: id + '@localhost', roles: [], marks: [], enabled: true, kid: false, seenAt: now });
  delete u.plan; delete u.title; delete u.flair;
  return u;
});
db.user4.insertMany(users);
db.pref.insertMany(rows.map(([id]) => Object.assign({}, ptpl, { _id: id })));
db.oauth2_access_token.insertMany(rows.map(([id, h]) => ({ _id: h, userId: id, created: now, description: 'seazn load', scopes })));
const ids = rows.map(([id]) => id);
print(JSON.stringify({
  users: db.user4.countDocuments({ _id: { $in: ids } }),
  prefs: db.pref.countDocuments({ _id: { $in: ids } }),
  tokens: db.oauth2_access_token.countDocuments({ userId: { $in: ids } }),
  follows: db.relation.countDocuments({ $or: [{ u1: { $in: ids } }, { u2: { $in: ids } }] }),
  relationDocsInSeed: db.relation.countDocuments({}),
}));
JS
} > "$WORK/mint.js"
docker cp "$WORK/mint.js" "$NAME:/tmp/mint.js"
MINTED="$(docker exec "$NAME" mongosh --quiet lichess /tmp/mint.js | tail -1)"
echo "minted: $MINTED"
# Anti-vacuity: the follow count is only a check if the collection it reads is the one the seed fills.
# (No API-hog count: it would only re-read the `roles: []` written above. lila's own answer is the canary below - a hog's
# create costs 0 and is never refused - and the harness asks lila's /api/token/test for every player's STORED grant.)
if [ "$(jq -r '.users' <<< "$MINTED")" != "$MINT_N" ] || [ "$(jq -r '.prefs' <<< "$MINTED")" != "$MINT_N" ] || [ "$(jq -r '.tokens' <<< "$MINTED")" != "$MINT_N" ] \
  || [ "$(jq -r '.follows' <<< "$MINTED")" != "0" ] || [ "$(jq -r '.relationDocsInSeed' <<< "$MINTED")" = "0" ]; then
  echo "::error::minting did not leave $MINT_N users, prefs and tokens ($N players + the canary pair) with no follows and a seeded relation collection: $MINTED"; exit 1
fi

# THE LIMITER CANARY - the positive control. A run that measures 0 x 429 reads the same with lila's limiter ON and OFF, and
# the mono.conf check above proves only that the file landed, not what lila resolved. So before any player plays, the spare
# challenger sends six back-to-back creates to its non-follower, straight to lila (not through the proxy: the run's record
# never counts them). challengeUser charges a non-follower 5 credits of 25 a minute (Limiters.scala:93-98): the first five
# MUST be 200 and the sixth MUST be 429, or this lila does not enforce what production enforces and `up` stops here.
# Cost to the run: 6 of the per-IP challenge budget (500 / 10 min, Limiters.scala:92), none of any player's own.
# No body is read or logged: a create answers with the challenge, a refusal with {"error": ...}.
CANARY_STATUSES=""
T_CANARY=$(date +%s)
for _ in 1 2 3 4 5 6; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Authorization: Bearer $CANARY_TOK" \
    --data 'clock.limit=600&clock.increment=5' "$BASE/api/challenge/$CANARY_DEST" || true)"
  CANARY_STATUSES="$CANARY_STATUSES ${code:-000}"
done
CANARY_STATUSES="${CANARY_STATUSES# }"
T_CANARY_DONE=$(date +%s)
echo "limiter canary: $CANARY -> $CANARY_DEST, six creates answered: $CANARY_STATUSES (200 x5 then 429 expected)"
if [ "$CANARY_STATUSES" != "200 200 200 200 200 429" ]; then
  echo "::error::lila's challenge limiter is NOT live: six creates to a non-follower answered '$CANARY_STATUSES', not '200 200 200 200 200 429'. A run on this lila would read 0 x 429 whatever the product did, so it is not started. Check the image's supervisord -Dconfig.file and net.ratelimit (see the LILA_IMAGE_PINNED comment)."
  exit 1
fi
# And lila says WHY it refused: RateLimit logs a refusal only when it enforces (lila memo RateLimit.scala:44-45).
CANARY_LOGGED=0
for _ in $(seq 1 15); do
  CANARY_LOGGED="$(docker logs "$NAME" 2>&1 | grep -ac 'challenge\.create\.user' || true)"
  if [ "${CANARY_LOGGED:-0}" -ge 1 ]; then break; fi
  sleep 1
done
if [ "${CANARY_LOGGED:-0}" -lt 1 ]; then
  echo "::error::the canary's sixth create was a 429, but lila logged no challenge.create.user refusal: something other than lila's limiter answered it"; exit 1
fi
CANARY_JSON="$(jq -nc --arg s "$CANARY_STATUSES" --argjson secs "$((T_CANARY_DONE - T_CANARY))" --argjson logged "$CANARY_LOGGED" \
  '{challenger: "szlcanary", destination: "szlcanarydest", statuses: ($s | split(" ") | map(tonumber)), limiterLive: true, refusedAt: 6, seconds: $secs, refusalLogLines: $logged, perIpBudgetSpent: 6}')"

( umask 077; jq -sc . "$WORK/accounts.ndjson" > "$ACC" )
rm -f "$WORK/accounts.ndjson"
# The first and the last token answer as their own accounts (the harness then checks every one).
for id in szl0001 "$(printf 'szl%04d' "$N")"; do
  tok="$(jq -r --arg id "$id" '.[] | select(.id == $id) | .token' "$ACC")"
  got="$(curl -s -H "Authorization: Bearer $tok" "$BASE/api/account" | jq -r '.id // "none"')"
  if [ "$got" != "$id" ]; then echo "::error::the token minted for $id answers /api/account as $got"; exit 1; fi
done

jq -n \
  --arg image "$IMG" \
  --arg pinned "$LILA_IMAGE_PINNED" \
  --arg digest "$(docker image inspect "$IMG" --format '{{index .RepoDigests 0}}')" \
  --arg version "$(docker exec "$NAME" cat /lila/conf/version.conf 2>/dev/null | head -3 | tr '\n' ' ' | san)" \
  --arg ratelimit "$EFFECTIVE" \
  --arg imageDefault "$(grep -a '^net.ratelimit' "$WORK/mono.conf.orig" || true)" \
  --argjson pullS "$((T_PULL1 - T_PULL0))" \
  --argjson bootS "$((READY - T_RUN))" \
  --argjson minted "$MINTED" \
  --argjson scopes "$SCOPES_JSON" \
  --argjson canary "$CANARY_JSON" \
  '{image: $image, pinned: ($image == $pinned), digest: $digest, version: $version, ratelimit: $ratelimit, imageDefault: $imageDefault, pullSeconds: $pullS, bootSeconds: $bootS, minted: $minted, scopes: $scopes, canary: $canary}' \
  | san > "$OUT/boot.json"
cat "$OUT/boot.json"
