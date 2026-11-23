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
#                     (lila Challenge.scala:308, Limiters.scala:92-98).
#   lila-up.sh logs   after the run: lila's log, sanitised, and the ratelimit lines pulled out of it.
#
# The recipe, the token shape and every trap are the 2026-11-22 spike's (.superpowers/sdd/2026-11-17-chess-external-play/
# lila-spike-report.md, branch spike/lila-ci): a token is found by `_id = sha256(plaintext)` in `oauth2_access_token`
# (lila AccessToken.scala:48) and lila takes a freshly inserted one without a restart.
#
# Env (up):   LILA_ACCOUNT_COUNT  accounts to mint (LOAD_BOARDS x 2)
#             LILA_ACCOUNTS       where to write them: a JSON array of {id, token, scopes}. It holds TOKENS: keep it out of
#                                 every artifact (load.yml writes it under RUNNER_TEMP, never under load-out/).
#             LILA_OUT            a directory for the sanitised facts of the boot (uploaded with the report)
#             LILA_IMAGE          optional, default ghcr.io/lichess-org/lila-docker:main
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
  echo "{\"httpBoots\": ${boots:-0}, \"ratelimitLines\": $(wc -l < "$OUT/ratelimit.log")}" > "$OUT/after-run.json"
  exit 0
fi

if [ "$MODE" != "up" ]; then echo "usage: lila-up.sh up|logs" >&2; exit 2; fi

N="${LILA_ACCOUNT_COUNT:?LILA_ACCOUNT_COUNT is required}"
ACC="${LILA_ACCOUNTS:?LILA_ACCOUNTS is required}"
IMG="${LILA_IMAGE:-ghcr.io/lichess-org/lila-docker:main}"
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
WORK="$(mktemp -d "${RUNNER_TEMP:-/tmp}/lila.XXXXXX")"
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

# Mint: ids szl0001..; a random token each, masked at once, hashed here so the container only ever sees the sha256.
: > "$WORK/rows.js"
: > "$WORK/accounts.ndjson"
for i in $(seq 1 "$N"); do
  id="$(printf 'szl%04d' "$i")"
  tok="lip_$(openssl rand -hex 20)"
  echo "::add-mask::$tok"
  hash="$(printf '%s' "$tok" | sha256sum | cut -d' ' -f1)"
  echo "  ['$id', '$hash']," >> "$WORK/rows.js"
  jq -nc --arg id "$id" --arg token "$tok" --argjson scopes "$SCOPES_JSON" '{id: $id, token: $token, scopes: $scopes}' >> "$WORK/accounts.ndjson"
done
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
  apiHogs: db.user4.countDocuments({ _id: { $in: ids }, roles: 'ROLE_API_HOG' }),
  relationDocsInSeed: db.relation.countDocuments({}),
}));
JS
} > "$WORK/mint.js"
docker cp "$WORK/mint.js" "$NAME:/tmp/mint.js"
MINTED="$(docker exec "$NAME" mongosh --quiet lichess /tmp/mint.js | tail -1)"
echo "minted: $MINTED"
# Anti-vacuity: the follow count is only a check if the collection it reads is the one the seed fills.
if [ "$(jq -r '.users' <<< "$MINTED")" != "$N" ] || [ "$(jq -r '.prefs' <<< "$MINTED")" != "$N" ] || [ "$(jq -r '.tokens' <<< "$MINTED")" != "$N" ] \
  || [ "$(jq -r '.follows' <<< "$MINTED")" != "0" ] || [ "$(jq -r '.apiHogs' <<< "$MINTED")" != "0" ] || [ "$(jq -r '.relationDocsInSeed' <<< "$MINTED")" = "0" ]; then
  echo "::error::minting did not leave $N users, prefs and tokens with no follows, no API hog, and a seeded relation collection: $MINTED"; exit 1
fi

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
  --arg digest "$(docker image inspect "$IMG" --format '{{index .RepoDigests 0}}')" \
  --arg version "$(docker exec "$NAME" cat /lila/conf/version.conf 2>/dev/null | head -3 | tr '\n' ' ' | san)" \
  --arg ratelimit "$EFFECTIVE" \
  --arg imageDefault "$(grep -a '^net.ratelimit' "$WORK/mono.conf.orig" || true)" \
  --argjson pullS "$((T_PULL1 - T_PULL0))" \
  --argjson bootS "$((READY - T_RUN))" \
  --argjson minted "$MINTED" \
  --argjson scopes "$SCOPES_JSON" \
  '{image: $image, digest: $digest, version: $version, ratelimit: $ratelimit, imageDefault: $imageDefault, pullSeconds: $pullS, bootSeconds: $bootS, minted: $minted, scopes: $scopes}' \
  | san > "$OUT/boot.json"
cat "$OUT/boot.json"
