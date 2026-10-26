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
#
# A malformed pin is an error, not an empty string: `::error::` goes to STDERR and the exit status is 1. STDERR matters. The
# caller is `ref="$(bash …/placement-image.sh ref)"`, which captures stdout, so an annotation printed there would be swallowed
# into $ref and the failure would arrive with no message.
#
# Only the PULL is retried: it is the one step that talks to a registry, and a transient 5xx there should not red a whole job.
# A retag or inspect that fails is a real failure and stops the script at once. After the last attempt the script fails with
# an `::error::`; it never loops on.
#
# jq is required (present on GitHub's ubuntu runners); its absence is an `::error::` naming it, not a confusing failure from
# inside a command substitution.
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

# `jq -j` writes no trailing newline, and the sentinel `x` keeps `$(…)` from stripping one that belongs to the value: a tag
# that is 40 hex characters PLUS a newline must be refused, not trimmed into a valid one. A jq failure (not JSON, not an
# object) leaves the tag empty, which the check below refuses; jq's own message stays on stderr.
tag="$(jq -j '.imageTag // empty' "$pin"; printf x)"
tag="${tag%x}"
tag_re='^[0-9a-f]{40}$'
[[ "$tag" =~ $tag_re ]] || fail "imageTag in $pin must be a 40-character lowercase hex commit sha, got '${tag}'"

ref="$IMAGE_REPO:$tag"

if [ "$mode" = ref ]; then
  printf '%s\n' "$ref"
  exit 0
fi

# Validate before the first docker call: a typo here must not become a `sleep` error on the second attempt.
backoff="${PLACEMENT_PULL_BACKOFF_S:-5}"
backoff_re='^[0-9]+$'
[[ "$backoff" =~ $backoff_re ]] || fail "PLACEMENT_PULL_BACKOFF_S must be a whole number of seconds, got '${backoff}'"

attempts=3
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
