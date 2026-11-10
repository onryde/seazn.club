#!/usr/bin/env bash
# Is this pull request docs-only? Writes `code=true` or `code=false` to
# $GITHUB_OUTPUT (and says why on stdout). ci.yml's `changes` job runs it, and
# every heavy job skips on `code=false`; the header above that job says which.
#
# Inputs (env):
#   EVENT_NAME          github.event_name
#   CHANGED_FILES_JSON  dorny/paths-filter's `<filter>_files` for a '**' filter:
#                       a JSON array of repo-relative paths, a rename already
#                       split into its old and its new name
#
# `code=false` needs BOTH:
#   1. every changed path is docs/**, mockups/**, .claude/**, or a ROOT-level
#      *.md / *.txt. An .md anywhere else is code: unit and DB tests content-scan
#      the .md files inside apps/, scripts/ and tools/.
#   2. no tracked code file names any changed file's basename, or any folder it
#      sits in (bar the structural ones below). That is how ~40 tests read a doc,
#      and a docs PR that edits one must run them. The search skips docs/,
#      mockups/, .claude/ and every *.md / *.txt: prose that mentions a doc does
#      not read it.
#
# Everything else answers `code=true` — another event, an empty or unparsable
# list, a list at the API's 3000-file cap, a git grep that errors. A false
# "code" costs one full CI run; a false "docs-only" merges a red. It always
# exits 0 once it has answered, so the answer, not the exit code, drives CI.
set -euo pipefail

answer() {
  local code="$1"
  shift
  printf 'code=%s: %s\n' "$code" "$*"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'code=%s\n' "$code" >>"$GITHUB_OUTPUT"
  fi
  exit 0
}

if [ "${EVENT_NAME:-}" != "pull_request" ]; then
  answer true "the event is '${EVENT_NAME:-}', not pull_request; only a pull request may skip anything"
fi

# No `-e`: with it, an EMPTY array exits 4 and would read as "unparsable".
if ! files="$(printf '%s' "${CHANGED_FILES_JSON:-}" | jq -r 'if type == "array" and all(.[]; type == "string") then .[] else error("not an array of strings") end' 2>/dev/null)"; then
  answer true "the changed-file list is not a JSON array of strings, so nothing shows the change is docs-only"
fi
if [ -z "$files" ]; then
  answer true "no changed files, so nothing shows the change is docs-only"
fi
count="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
if [ "$count" -ge 3000 ]; then
  answer true "$count changed files: at the pull-request API's 3000-file cap the list may be cut short"
fi

# A function, not an inline loop: bash 3.2 (macOS) mis-parses a `case` pattern's
# `)` inside `$( … )` as the end of the substitution.
code_paths_of() {
  local f
  while IFS= read -r f; do
    case "$f" in
      docs/* | mockups/* | .claude/*) ;;
      */*) printf '%s\n' "$f" ;;
      *.md | *.txt) ;;
      *) printf '%s\n' "$f" ;;
    esac
  done
}
code_paths="$(printf '%s\n' "$files" | code_paths_of)"
if [ -n "$code_paths" ]; then
  answer true "$(printf '%s\n' "$code_paths" | wc -l | tr -d ' ') of $count changed paths are code, e.g. $(printf '%s\n' "$code_paths" | head -3 | tr '\n' ' ')"
fi

# Every basename, plus every folder name except the structural ones that name
# half the repo's docs and so would make every docs PR read as code.
names="$(
  {
    printf '%s\n' "$files" | sed 's|.*/||'
    printf '%s\n' "$files" | sed -n 's|/[^/]*$||p' | tr '/' '\n' |
      grep -v -x -F -e docs -e superpowers -e specs -e plans -e mockups -e .claude -e agents || true
  } | grep -v -x -F -e '' | sort -u || true
)"
if [ -z "$names" ]; then
  answer true "no file or folder name to look for, so nothing shows the change is docs-only"
fi

names_file="$(mktemp)"
trap 'rm -f "$names_file"' EXIT
printf '%s\n' "$names" >"$names_file"
name_count="$(wc -l <"$names_file" | tr -d ' ')"

search() {
  git grep -I -F -f "$names_file" "$@" -- . ':(exclude)docs' ':(exclude)mockups' ':(exclude).claude' ':(exclude)*.md' ':(exclude)*.txt'
}
# -q first: it stops at the first hit. Capturing every matching line instead
# took minutes when a common name (a one-letter folder) matched most of the repo.
set +e
err="$(search -q 2>&1)"
rc=$?
set -e
case "$rc" in
  0)
    printf 'docs-only by path, but tracked code names a changed file or folder:\n'
    search -n | head -10 | cut -c1-200 || true
    answer true "$count docs path(s), but code reads at least one of them by name"
    ;;
  1)
    answer false "$count changed path(s), all docs, none of their $name_count file or folder names appears in tracked code"
    ;;
  *)
    printf '%s\n' "$err" | head -5
    answer true "git grep failed (exit $rc), so nothing shows the change is docs-only"
    ;;
esac
