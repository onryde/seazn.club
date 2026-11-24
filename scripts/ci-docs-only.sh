#!/usr/bin/env bash
# Which lane is this pull request in: docs-only, content-only, or code? Writes two
# lines to $GITHUB_OUTPUT (and says why on stdout). ci.yml's `changes` job runs it,
# and the heavy jobs skip on what it answers; the header above that job says which.
#
#   code=false content=false   docs-only: nothing heavy runs
#   code=true  content=true    content-only: the jobs that READ help/blog content run,
#                              the rest skip (the list is in ci.yml's `changes` header,
#                              and scripts/__tests__/ci-content-lane.test.ts pins it);
#                              smoke-db runs too, but only the readers in
#                              scripts/content-db-readers.json, not its suite
#   code=true  content=false   code: everything runs
#
# Inputs (env):
#   EVENT_NAME          github.event_name
#   CHANGED_FILES_JSON  dorny/paths-filter's `<filter>_files` for a '**' filter:
#                       a JSON array of repo-relative paths, a rename already
#                       split into its old and its new name
#
# A changed path is one of three kinds:
#   docs     docs/**, mockups/**, .claude/**, or a ROOT-level *.md / *.txt. An .md
#            anywhere else is code: unit and DB tests content-scan the .md files
#            inside apps/, scripts/ and tools/.
#   content  an .md file or a picture (.webp .png .jpg .jpeg .gif .avif) under
#            apps/web/content/help/, apps/web/content/blog/ or apps/web/public/help/.
#            These are the three roots the help and blog loaders read (HELP_ROOT,
#            BLOG_ROOT, and the figures under public/help); the .md files in them are
#            NOT docs, because the help-copy sweeps, the blog goldens and the leak,
#            picture and link guards read them. Anything else under those roots (a
#            .ts, a .json, an .svg, a file with no extension) is code: it is not
#            something the loaders read as content, and only an .md or a picture is
#            what the lane's reader sweep reasoned about.
#   code     everything else.
#
# `code=false` (docs-only) needs BOTH:
#   1. every changed path is a docs path, and
#   2. no tracked code file names any changed file's basename, or any folder it
#      sits in (bar the structural ones below). That is how ~40 tests read a doc,
#      and a docs PR that edits one must run them. The search skips docs/,
#      mockups/, .claude/ and every *.md / *.txt: prose that mentions a doc does
#      not read it.
#
# `content=true` (content-only) needs ALL of:
#   1. every changed path is a content path or a docs path (a docs path in the same
#      pull request must pass rule 2 above on its own),
#   2. at least one is a content path, and
#   3. no tracked code file names a changed content file's BASENAME (a section
#      folder such as `billing` or `sports` names half the repo, so folders are not
#      searched for a content path). This is a cheap tripwire, NOT the argument that
#      the lane is safe: it sees a test that spells a file name, and does not see one
#      that reaches an article by slug (helpArticleBySlug("sharing/embeds")), by
#      section, or by walking the directory. What makes the lane safe is
#      scripts/__tests__/ci-content-lane.test.ts: its reader sweep derives, by
#      behaviour, every test that reads help or blog content however it names it,
#      and proves each one runs in a job that stays in the lane. A reader this name
#      search misses is therefore still run. Measured when this was written: 64 of
#      the 251 content files (143 .md, 108 .webp) are named somewhere in code, so a
#      PR that touches one of those answers `code` and runs everything: a false
#      "code" costs one full run.
#
# Why a content PR cannot simply skip every DB job: the DB-gated halves of
# help-copy-truth, pricing-cards, retired-plan-copy, dictionary-copy-truth and
# help-token-cells compare the help articles with the plan_entitlements rows, and
# those run only in smoke-db. So smoke-db stays in the content lane, but it runs
# ONLY the content readers it owns (scripts/content-db-readers.json, run by
# scripts/ci-content-db-readers.sh, which fails if it ran none or any other), not the
# ~300 DB, Redis, Stripe and placement tests a content change cannot move. Which jobs
# skip, the proof that none of them runs a test that reads content, and the proof that
# the manifest is exactly the readers only smoke-db covers, is
# scripts/__tests__/ci-content-lane.test.ts; this script decides only the lane.
#
# Everything else answers `code=true content=false` — another event, an empty or
# unparsable list, a list at the API's 3000-file cap, a git grep that errors. A false
# "code" costs one full CI run; a false "docs-only" or "content-only" merges a red.
# It always exits 0 once it has answered, so the answer, not the exit code, drives CI.
set -euo pipefail

answer() {
  local code="$1" content="$2"
  shift 2
  printf 'code=%s content=%s: %s\n' "$code" "$content" "$*"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'code=%s\ncontent=%s\n' "$code" "$content" >>"$GITHUB_OUTPUT"
  fi
  exit 0
}

if [ "${EVENT_NAME:-}" != "pull_request" ]; then
  answer true false "the event is '${EVENT_NAME:-}', not pull_request; only a pull request may skip anything"
fi

# No `-e`: with it, an EMPTY array exits 4 and would read as "unparsable".
if ! files="$(printf '%s' "${CHANGED_FILES_JSON:-}" | jq -r 'if type == "array" and all(.[]; type == "string") then .[] else error("not an array of strings") end' 2>/dev/null)"; then
  answer true false "the changed-file list is not a JSON array of strings, so nothing shows the change is docs-only or content-only"
fi
if [ -z "$files" ]; then
  answer true false "no changed files, so nothing shows the change is docs-only or content-only"
fi
count="$(printf '%s\n' "$files" | wc -l | tr -d ' ')"
if [ "$count" -ge 3000 ]; then
  answer true false "$count changed files: at the pull-request API's 3000-file cap the list may be cut short"
fi

# Functions, not inline loops: bash 3.2 (macOS) mis-parses a `case` pattern's `)`
# inside `$( … )` as the end of the substitution. kind_of sets $kind rather than
# printing it, so classifying 3000 paths forks nothing.
kind_of() {
  case "$1" in
    docs/* | mockups/* | .claude/*) kind=docs ;;
    apps/web/content/help/* | apps/web/content/blog/* | apps/web/public/help/*)
      # Only an article or a picture is content; a .ts or .json dropped in a content folder is code.
      case "$1" in
        *.md | *.webp | *.png | *.jpg | *.jpeg | *.gif | *.avif) kind=content ;;
        *) kind=code ;;
      esac
      ;;
    */*) kind=code ;;
    *.md | *.txt) kind=docs ;;
    *) kind=code ;;
  esac
}
paths_of() {
  local want="$1" f kind=""
  while IFS= read -r f; do
    kind_of "$f"
    if [ "$kind" = "$want" ]; then
      printf '%s\n' "$f"
    fi
  done
  return 0
}
code_paths="$(printf '%s\n' "$files" | paths_of code)"
if [ -n "$code_paths" ]; then
  answer true false "$(printf '%s\n' "$code_paths" | wc -l | tr -d ' ') of $count changed paths are code, e.g. $(printf '%s\n' "$code_paths" | head -3 | tr '\n' ' ')"
fi
docs_paths="$(printf '%s\n' "$files" | paths_of docs)"
content_paths="$(printf '%s\n' "$files" | paths_of content)"

# What to look for in code. A docs path: its basename, plus every folder name except
# the structural ones that name half the repo's docs and so would make every docs PR
# read as code. A content path: its basename only (see rule 3 above).
names="$(
  {
    if [ -n "$docs_paths" ]; then
      printf '%s\n' "$docs_paths" | sed 's|.*/||'
      printf '%s\n' "$docs_paths" | sed -n 's|/[^/]*$||p' | tr '/' '\n' |
        grep -v -x -F -e docs -e superpowers -e specs -e plans -e mockups -e .claude -e agents || true
    fi
    if [ -n "$content_paths" ]; then
      printf '%s\n' "$content_paths" | sed 's|.*/||'
    fi
  } | grep -v -x -F -e '' | sort -u || true
)"
if [ -z "$names" ]; then
  answer true false "no file or folder name to look for, so nothing shows the change is docs-only or content-only"
fi

names_file="$(mktemp)"
trap 'rm -f "$names_file"' EXIT
printf '%s\n' "$names" >"$names_file"
name_count="$(wc -l <"$names_file" | tr -d ' ')"

# The content roots are excluded as well as the docs: a help article that names a
# picture is prose, and the pictures are binary (-I skips them) — neither reads a
# changed file. Code under any other path counts.
search() {
  git grep -I -F -f "$names_file" "$@" -- . ':(exclude)docs' ':(exclude)mockups' ':(exclude).claude' ':(exclude)*.md' ':(exclude)*.txt' ':(exclude)apps/web/content' ':(exclude)apps/web/public/help'
}
# -q first: it stops at the first hit. Capturing every matching line instead
# took minutes when a common name (a one-letter folder) matched most of the repo.
set +e
err="$(search -q 2>&1)"
rc=$?
set -e
case "$rc" in
  0)
    printf 'docs-only or content-only by path, but tracked code names a changed file or folder:\n'
    search -n | head -10 | cut -c1-200 || true
    answer true false "$count changed path(s), but code reads at least one of them by name"
    ;;
  1)
    if [ -z "$content_paths" ]; then
      answer false false "$count changed path(s), all docs, none of their $name_count file or folder names appears in tracked code"
    fi
    answer true true "$count changed path(s), all docs or help/blog content ($(printf '%s\n' "$content_paths" | wc -l | tr -d ' ') of them content), none of their $name_count name(s) appears in tracked code"
    ;;
  *)
    printf '%s\n' "$err" | head -5
    answer true false "git grep failed (exit $rc), so nothing shows the change is docs-only or content-only"
    ;;
esac
