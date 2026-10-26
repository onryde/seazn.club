#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# The ONE place a placement image reference is made (engine-split phase 2a, Task W2).
#
# The placement service lives in its own repo, which publishes one immutable image per commit:
#
#     ghcr.io/onryde/seazn-placement:<40-hex placement commit sha>
#
# packages/scheduler/VENDORED.json pins that sha (`imageTag`), written by `vendor:proto` from the same `git rev-parse HEAD`
# as the proto it vendors, so the image CI runs can never be older than the proto the TypeScript stubs were generated from.
# Every CI job that needs the service gets it through this script; none builds it from source and none types a tag
# (packages/scheduler/test/placement-image-wiring.test.ts pins both).
#
#   placement-image.sh ref    print the pinned reference on stdout (and nothing else)
#   placement-image.sh pull   docker pull it (3 attempts at most, $PLACEMENT_PULL_BACKOFF_S seconds apart, default 5),
#                             retag it `placement-service:ci` (the name the jobs' `docker run` lines use), then print the
#                             digest(s) that were pulled
#   placement-image.sh verify-pin
#                             fetch proto/scheduler.proto at the pinned `placementCommit` from the placement repo (anonymous,
#                             raw.githubusercontent.com) and require its sha256 to equal VENDORED.json's `sha256`. The other
#                             modes trust the pin; this is the one check that the pin is not a lie (copy and sha256 updated,
#                             commit stale or never pushed). A 404 fails at once (the commit is not there); any other non-200
#                             is retried like the pull.
#
# A malformed pin is an error, not an empty string: `::error::` goes to STDERR and the exit status is 1. STDERR matters. The
# caller is `ref="$(bash …/placement-image.sh ref)"`, which captures stdout, so an annotation printed there would be swallowed
# into $ref and the failure would arrive with no message.
#
# Only the PULL and the verify-pin FETCH are retried: they are the steps that talk to the network, and a transient 5xx there
# should not red a whole job. A retag or inspect that fails is a real failure and stops the script at once. After the last
# attempt the script fails with an `::error::`; it never loops on. Both read $PLACEMENT_PULL_BACKOFF_S.
#
# jq is required (present on GitHub's ubuntu runners), and curl for verify-pin; an absence is an `::error::` naming the tool,
# not a confusing failure from inside a command substitution.
#
# The pin file is `$PLACEMENT_VENDORED_JSON` when set (the tests aim it at fixtures), else VENDORED.json next to this script's
# directory — the script's own location, never the caller's working directory.
#
# SPEC §13: the package is PUBLIC today, so `docker pull` and a job's `services:` pull need no login. If it ever goes private,
# every caller needs `packages: read` on its job and a `docker login ghcr.io` before `pull`, and a `services:` container needs
# `credentials:`. Until then the anonymous pull is also the proof that the package really is public.
# ---------------------------------------------------------------------------
set -euo pipefail

IMAGE_REPO="ghcr.io/onryde/seazn-placement"
RAW_BASE="https://raw.githubusercontent.com/onryde/seazn.club.placement"
LOCAL_TAG="placement-service:ci"

fail() {
  printf '::error::placement-image.sh: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: placement-image.sh ref|pull|verify-pin (got $# arguments)"
mode="$1"
case "$mode" in
  ref | pull | verify-pin) ;;
  *) fail "unknown mode '$mode' (expected ref, pull or verify-pin)" ;;
esac

command -v jq > /dev/null || fail "jq is required to read the pin and is not on PATH"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pin="${PLACEMENT_VENDORED_JSON:-$script_dir/../VENDORED.json}"
[ -f "$pin" ] || fail "the pin file $pin does not exist"

# Sets $FIELD to the pin's string field $1 (empty when absent, null or not JSON). `jq -j` writes no trailing newline, and the
# sentinel `x` keeps `$(…)` from stripping one that belongs to the value: a tag that is 40 hex characters PLUS a newline must
# be refused, not trimmed into a valid one. It assigns a global instead of printing because printing would go through another
# `$(…)` and lose the newline again. A jq failure (not JSON, not an object) leaves the field empty, which every caller refuses;
# jq's own message stays on stderr.
pin_field() {
  local value
  value="$(jq -j --arg key "$1" '.[$key] // empty' "$pin"; printf x)"
  FIELD="${value%x}"
}

hex40_re='^[0-9a-f]{40}$'
hex64_re='^[0-9a-f]{64}$'
attempts=3

# Validate before the first network call: a typo here must not become a `sleep` error on the second attempt.
backoff="${PLACEMENT_PULL_BACKOFF_S:-5}"
check_backoff() {
  local re='^[0-9]+$'
  [[ "$backoff" =~ $re ]] || fail "PLACEMENT_PULL_BACKOFF_S must be a whole number of seconds, got '${backoff}'"
}

if [ "$mode" = verify-pin ]; then
  command -v curl > /dev/null || fail "curl is required to verify the pin against the placement repo and is not on PATH"
  if command -v sha256sum > /dev/null; then
    sha_cmd=(sha256sum)
  elif command -v shasum > /dev/null; then
    sha_cmd=(shasum -a 256)
  else
    fail "neither sha256sum nor shasum is on PATH"
  fi
  pin_field placementCommit
  commit="$FIELD"
  [[ "$commit" =~ $hex40_re ]] || fail "placementCommit in $pin must be a 40-character lowercase hex commit sha, got '${commit}'"
  pin_field sha256
  want="$FIELD"
  [[ "$want" =~ $hex64_re ]] || fail "sha256 in $pin must be 64 lowercase hex characters, got '${want}'"
  check_backoff

  url="$RAW_BASE/$commit/proto/scheduler.proto"
  body="$(mktemp)"
  trap 'rm -f "$body"' EXIT
  status=""
  rc=0
  fetched=""
  for attempt in $(seq 1 "$attempts"); do
    # No --fail: the HTTP status is read, not inferred from the exit code, so a 404 (permanent) can be told from a 5xx or a
    # dropped connection (transient). A connection failure prints 000 and exits non-zero, which `|| rc=$?` absorbs. A 200
    # whose transfer was cut short (curl exits 18, status still 200) is NOT a fetched file: its half body would hash to
    # something else and read as a lying pin, so success needs the status AND a clean curl exit.
    rc=0
    status="$(curl --silent --show-error --location --max-time 30 --output "$body" --write-out '%{http_code}' "$url")" || rc=$?
    if [ "$rc" -eq 0 ] && [ "$status" = 200 ]; then
      fetched=1
      break
    fi
    [ "$status" = 404 ] && fail "no proto/scheduler.proto at placement commit $commit (HTTP 404 from $url): the commit is not pushed to onryde/seazn.club.placement, or the pin in $pin was edited by hand"
    if [ "$attempt" -lt "$attempts" ]; then
      printf '::warning::placement-image.sh: fetching %s failed (HTTP %s, curl exit %s, attempt %s of %s); retrying in %ss\n' "$url" "${status:-none}" "$rc" "$attempt" "$attempts" "$backoff" >&2
      sleep "$backoff"
    fi
  done
  [ -n "$fetched" ] || fail "could not fetch $url after $attempts attempts (last HTTP status ${status:-none}, curl exit $rc), so the pin was not verified"

  got="$("${sha_cmd[@]}" "$body" | cut -d' ' -f1)"
  [ "$got" = "$want" ] || fail "the pin lies: $pin says sha256 $want, but proto/scheduler.proto at placement commit $commit hashes to $got. Likely causes: placementCommit is stale (the proto was re-vendored without updating it, or from an unpushed commit), or VENDORED.json or the vendored copy was edited by hand. Re-run vendor:proto from a clean, pushed placement checkout."
  printf 'pin verified: proto/scheduler.proto at placement commit %s has sha256 %s\n' "$commit" "$got"
  exit 0
fi

pin_field imageTag
tag="$FIELD"
[[ "$tag" =~ $hex40_re ]] || fail "imageTag in $pin must be a 40-character lowercase hex commit sha, got '${tag}'"

ref="$IMAGE_REPO:$tag"

if [ "$mode" = ref ]; then
  printf '%s\n' "$ref"
  exit 0
fi

check_backoff

pulled=""
for attempt in $(seq 1 "$attempts"); do
  if docker pull "$ref"; then
    pulled=1
    break
  fi
  if [ "$attempt" -lt "$attempts" ]; then
    printf '::warning::placement-image.sh: docker pull %s failed (attempt %s of %s); retrying in %ss\n' "$ref" "$attempt" "$attempts" "$backoff" >&2
    sleep "$backoff"
  fi
done
[ -n "$pulled" ] || fail "docker pull $ref failed after $attempts attempts"

docker tag "$ref" "$LOCAL_TAG"
docker image inspect --format '{{json .RepoDigests}}' "$ref"
