# Prompt 09: CI workflow

**Context**: `docs/superpowers/specs/2026-08-07-cpsat-scheduler-design.md`,
section "CI" — mirrors this repo's existing PR-only, path-sensitive CI
culture (smoke CI is PR-only already). Statelessness (no DB, no Flyway
ceremony) is what makes running this in CI at all affordable — a real
advantage over most of this repo's CI, which gates expensive suites to
PR-only specifically because standing up a DB is not cheap.

**Acceptance criteria**: this workflow runs on PRs touching
`services/cp-sat/**` or `proto/**`, and **never** on a PR that touches
neither — that's the entire point, not an incidental detail.

**Do not touch**: any existing workflow file. This is additive only —
per AGENTS.md's standing rule, never enable `.github/workflows/e2e.yml`,
and this prompt has nothing to do with that file regardless.

**Files:**
- Create: `.github/workflows/cp-sat-service.yml`

---

## Corrections to this prompt (2026-08-09, from the Tasks 01-04 re-audit)

**1. `python-version: "3.11"` below is wrong** — the service is developed
and tested on **CPython 3.14.6** and its wheels are native `cp314`. CI on
3.11 would silently pass against a different interpreter from both dev
and prod. Note that `pyproject.toml` says `requires-python = ">=3.11"`,
so 3.11 *installs* cleanly and nothing warns you. That floor is now a
lie; raise it, or at minimum pin CI to 3.14 and say why in the workflow.

**2. This workflow triggers on `proto/**` but only tests Python — a real
gap.** The proto drift gate is **per-language**. The Python gate lives in
`tests/test_proto_compiles.py` (regenerates into a temp dir and
byte-compares the tracked stubs). The TypeScript stubs at
`packages/engine/src/scheduling/generated/scheduler.ts` have their own
regeneration path (`npm run gen:proto`, verified byte-identical).

So a PR that edits `proto/` and regenerates only the Python side passes
this workflow green while the TS stubs silently drift. Add a step that
regenerates the TS stubs and fails if `git status --porcelain` is
non-empty afterwards. This repo already has three CI-only drift gates
that work exactly this way (`openapi:gen`, `i18n:gen-keys`,
`schema:snapshot`) — follow that shape.

**3. Add `pip check`.** The pins here are an exact constraint
intersection: ortools `>=6.33.1,<6.34` ∩ grpcio-tools `>=6.33.5,<7`
= `>=6.33.5,<6.34`. The generated stubs also embed runtime version
assertions (`GRPC_GENERATED_VERSION`, `ValidateProtobufRuntimeVersion`)
that fail at import if the resolved runtime drifts. A resolver that
picks a satisfying-but-wrong combination should fail the job loudly, not
at first import in production.

**4. `pytest tests/ bench/` implies coverage that does not exist.**
`bench/` contains no `test_*.py` and `pytest bench/` exits **5**, "no
tests ran" — Prompt 02's Step 2b told an implementer to run exactly that
as a verification, and it could never have verified anything. Prompt 05b
adds `tests/test_bench_contract.py`, which guards the bench contract from
inside `tests/`. Run `tests/` and drop `bench/`, or keep it and know it
contributes nothing.

---

- [ ] **Step 1: Write the workflow**

```yaml
name: cp-sat-service

on:
  pull_request:
    paths:
      - "services/cp-sat/**"
      - "proto/**"

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: "3.11"
      - run: cd services/cp-sat && pip install -e ".[dev]"
      - run: cd services/cp-sat && python3 -m pytest tests/ bench/ -v
```

- [ ] **Step 2: Verify the path filter is correct**

After pushing, confirm via `gh workflow view cp-sat-service.yml` — or by
re-reading the `paths:` block above against a hypothetical PR that only
touches `apps/web/**` — that such a PR would NOT trigger this job. If
you have a live PR to check against, run `gh pr checks <PR#>` on one
that doesn't touch `services/cp-sat/**` and confirm this workflow is
absent from the list entirely (not present-and-skipped — absent).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/cp-sat-service.yml
git commit -m "ci: path-filtered workflow for the cp-sat service"
```

**Verify**: workflow YAML is valid (`gh workflow view` doesn't error), and the `paths:` block matches exactly `services/cp-sat/**` and `proto/**` — no broader glob that would fire on unrelated PRs.

**Output cap**: final message under 15 lines — confirm path filter, confirm no other workflow file was touched.
