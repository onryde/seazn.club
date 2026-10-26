#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# The ONE place a placement image reference is made (engine-split phase 2a, Task W2).
#
# The placement service lives in its own repo, which publishes one immutable image per commit:
#
#     ghcr.io/onryde/seazn-placement:<40-hex placement commit sha>
#
# packages/scheduler/VENDORED.json holds that sha (`imageTag`), the only thing in it. `vendor:proto` writes it from the same
# `git rev-parse HEAD` as the proto it vendors. Nothing in CI checks it against the placement repo: a placement contract change is
# handled by hand (the owner asks both repos to regenerate), so this file is a pointer to the image CI pulls, not a verified
# claim. Every CI job that needs the service gets it through this script; none builds it from source and none types a tag
# (packages/scheduler/test/placement-image-wiring.test.ts pins both).
#
#   placement-image.sh ref    print the pinned reference on stdout (and nothing else)
#   placement-image.sh pull   docker pull it (3 attempts at most, $PLACEMENT_PULL_BACKOFF_S seconds apart, default 5),
#                             retag it `placement-service:ci` (the name the jobs' `docker run` lines use), then print the
#                             digest(s) that were pulled
#
# A malformed pin is an error, not an empty string: `::error::` goes to STDERR and the exit status is 1. STDERR matters. The
# caller is `ref="$(bash …/placement-image.sh ref)"`, which captures stdout, so an annotation printed there would be swallowed
# into $ref and the failure would arrive with no message.
#
# Only the PULL is retried: it is the step that talks to the network, and a transient 5xx there should not red a whole job. A
# retag or inspect that fails is a real failure and stops the script at once. After the last attempt the script fails with an
# `::error::`; it never loops on. The backoff is $PLACEMENT_PULL_BACKOFF_S.
#
# jq is required (present on GitHub's ubuntu runners); an absence is an `::error::` naming the tool, not a confusing failure
# from inside a command substitution.
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
LOCAL_TAG="placement-service:ci"

fail() {
  printf '::error::placement-image.sh: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "usage: placement-image.sh ref|pull (got $# arguments)"
mode="$1"
case "$mode" in
  ref | pull) ;;
  *) fail "unknown mode '$mode' (expected ref or pull)" ;;
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
attempts=3

# Validate before the first network call: a typo here must not become a `sleep` error on the second attempt.
backoff="${PLACEMENT_PULL_BACKOFF_S:-5}"
check_backoff() {
  local re='^[0-9]+$'
  [[ "$backoff" =~ $re ]] || fail "PLACEMENT_PULL_BACKOFF_S must be a whole number of seconds, got '${backoff}'"
}

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
