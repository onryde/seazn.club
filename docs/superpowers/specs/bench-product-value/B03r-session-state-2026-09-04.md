# B03r — session state, 2026-09-04

Written for continuity across a compaction. Companion to
`B03r-repins-2026-09-03.md` (the re-pin / false-premise record). Read both.

## Where the work is

- Worktree `/Users/ashokhein/github/seazn.club/.claude/worktrees/bench-b03r`
- Branch `feat/bench-b03r-registration`, **34 commits**, nothing pushed, no PR opened
- Baseline worktree for A/B triage: `.claude/worktrees/b03r-base` (detached at `3cfac6332`)

## Environment (all live right now)

| Piece | Value |
|---|---|
| DB | `seazn_b03r`, port **54867**, schema v391 |
| Prod server | **http://localhost:3305**, standalone, assets verified, `appDir` inside this worktree |
| Placement | localhost:**50748** |
| Baseline DB | label `b03rbase` |
| Bring-up | `eval "$(~/.claude/skills/seazn-local-env/scripts/seazn-env.sh env --label b03r)"` |
| Teardown when done | `seazn-env down --label b03r` **and** `--label b03rbase`; `git worktree remove .claude/worktrees/b03r-base` |

Stripe CLI is logged in; Chromium installed.

## Latest gate results (run by the main thread, not taken from an agent)

| Gate | Result |
|---|---|
| `scripts/bench` full suite | **714/714**, 0 outside worktree |
| `apps/web` register components | 317/317 |
| `apps/web` full suite (earlier) | 13,707/13,789 — all 8 reds explained, none from this diff |
| `tsc -p tsconfig.scripts.json` | clean |
| turbo lint + typecheck | 0 errors, 138 pre-existing warnings, cache-miss confirmed |

The 8 `apps/web` reds: 4 are `schedule-build-honours-locks` (placement service
down — 12/12 with it up, and identical on untouched `main`); the other 4 pass
in isolation and only appear in the full run (DB-volume artifact). Both proven
by A/B against the baseline worktree, not asserted.

## Owner rulings taken this session

| # | Ruling |
|---|---|
| 1 | **One PR**, product + bench together (deviates from the prompt's "PR 0 merged first" — record in PR body) |
| 2 | Prove the Stripe paid path **live** this session |
| 3 | Fix B03's F1 inside this PR — then found already fixed pre-merge; only F4 was real |
| 4 | **Drop** the hub `data-testid`s; drive off existing `data-field`/`data-action` |
| 5 | Move `currency` from the division block to **org level** in the pack |
| 6 | Fold in **both** schema gaps now (age cutoff fields, gender `"x"`) |
| 7 | §5.2's organiser-force eligibility half **hands to B04**; assert only the reachable submit half |

## Open questions put to the owner, not yet answered

- **Mixed-category and gender `x`.** `mixedCompositionTally` treats `x` and
  `null` identically, so an all-`x` pair fails a `mixed` division — two
  non-binary players cannot form a valid mixed-doubles pair. Consistent with
  "one of each" and possibly intended; flagged because it is the one place the
  "x never blocks" exemption stops holding, and it excludes people. Not a B03r
  defect either way (rule 1 derives from the product's own predicate).

## What is built

Bench: `lib/drivers/{types,http,browser}.ts`, `lib/register.ts` (mode resolver,
funnel oracle, organiser actions), `--entry` flag wired CLI→suite→report,
`env.ts` Stripe/Chromium pre-flight, `report.ts` funnel table + volume section,
**six** stage-0 rules in `validate-pack.ts`, `PackOrg.currency`,
`ageCutoffMonth`/`ageCutoffDay`, `PackPerson.gender` gains `"x"`,
`PlanSql.getOrgSlug`, `_tiny` gains a `registration-ui` division.

Product (test hooks only, no behaviour change): `reg-submit`, `reg-join-submit`,
`reg-consent-grant`, `reg-status-outcome` (+`data-status`, +`data-registration-id`),
`division-builder-category` (+`data-category` per option, on the LABEL),
`reg-next`, `reg-back`, `reg-who-playing`,
`reg-roster-name|squad|dob|gender` (+`data-player-row`).

## Live-run findings — the point of the whole exercise

Five live passes, four defects, **none visible to 699 green unit tests**:

1. **Wrong org slug.** `tiny.ts` used `plan.org.slug` (the pack's) for every
   public URL; the backend auto-provisions and names the org. `bench-tiny-club`
   → 404, `my-organization-2` → 200. A 404 there still serves HTTP 200 chrome,
   so it failed 30s later as a Playwright timeout on a *correct* selector.
   Fixed via `PlanSql.getOrgSlug`; throws rather than falling back.
2. **Wizard never advanced.** Next button and "I'm playing" checkbox had no
   stable selector; driver used a CSS-class chain and "first checkbox on page".
   The latter was actively wrong — `step-who.tsx:108` renders it only when
   `showSelfToggle` is true.
3. **The details step is not a no-op.** `validateDetails` requires every roster
   row's name; `goNext` silently refuses otherwise. Roster fields were
   addressable only by translated `aria-label`.
4. **Submit response body destroyed by navigation.** `response.json()` →
   "No resource with given identifier found". Now reads the landed status page
   instead — the stronger assertion, since it proves the UI agrees.

**A test of mine was decoration and was caught by mutation**: the
`data-player-row` index assertion lived in a single-row fixture, where a
hardcoded `0` is indistinguishable from a correct index. Moved to
`roster-table-hooks.test.tsx` with a three-player roster; the mutant now reds
2/4.

## The paid path — proven live, 2026-09-04

Owner ruling 2 is DONE. Driven against a real Stripe test-mode connected
account with a temporary `fee_cents:100` division (built in the scratchpad,
**never committed** — `_tiny` stays the free daily floor by design §9).

| Evidence | Value |
|---|---|
| Payment intents | 2 × `succeeded`, 100 GBP each, destination `acct_1U8o7FBlv9TBkyYa` |
| Webhook | `[200] POST /api/webhooks/stripe`, 8 `checkout.session.completed` — **accepted**, so `stripe listen → paid` is genuinely proven, not merely `?reconcile=1` |
| Row states | `paid`, then `confirmed` after the organiser approve |
| Funnel oracle | green at `paidCents 200`; funnel wall **39,936ms**, whole run 56s |
| Connect account | released — 0 holders afterwards |

Currency came back **GBP**, not the pack's declared `usd`. The connected
account's country wins. Not chased; recorded because a pack that declares a
currency may be declaring something inert.

**Five defects, found in a row, none visible to 704 passing tests.** Every one
needs a real connected account before the product will redirect to hosted
Checkout at all, which is why no unit test could reach them. Full detail in the
commit message of `68529b1f3`; the short list:

1. `enter()` returned `ref: ""` on the Stripe redirect, and `register.ts` only
   calls `pay()` when `entry.pay && outcome.ref` — so a pay-up-front entry was
   never paid. Silent.
2. `#billingPostalCode` filled unconditionally; this fixture draws no postal
   code, so it burned the full 30s locator budget on a field Stripe was never
   going to render.
3. `mapSubmitStatus` threw on `"paid"` — the vocabulary was enumerated from
   the free path, so the first successful payment ended in a throw on its own
   success. **Its test asserted the throw**, and had frozen the bug.
4. The status poll read `.status` off the v1 envelope instead of `data.status`,
   got `undefined`, and blamed the row for never settling.
5. An organiser action on an empty registration id waited 30s on
   `[data-registration-id=""]` instead of refusing.

And the one that made all of it unreachable in the first place:
`registration_settings.payment_method` defaults to `'offline'` and
`PutRegistrationSettings` defaults it AGAIN on every PUT that omits the key —
so both drivers were actively setting every division to offline, and
`resumeRegistrationCheckout` refuses anything but `"stripe"`. `payViaCheckout`
was written, typed and unit-green while being unreachable from every pack in
the tree. Closed by `PackRegistrationBlock.paymentMethod`, **stage-0 rule 7**,
and ONE shared body builder (`drivers/settings-body.ts`) — there were two
inline copies and they had already drifted, which is what the live run hit.

**Product fact worth keeping:** on a `payment_method: "stripe"` division the
product collects at SUBMIT. A pack's per-entry `pay: false` does not stop that
entry being charged — the first paid run reported `paidCents 200` against a
declared 100, and the expectation was wrong, not the product.

## Acceptance, line by line

| Criterion | State |
|---|---|
| Stage-0 kills the bad packs offline, naming the `ext_key` | done (rule 7 added, 3 tests + 2 mutants) |
| `_tiny` green: default (ui, Chromium) AND `--entry admin` (no Chromium) | **both green**; admin run has 0 browser mentions |
| Paid path proven live, `stripe listen` → `paid` → entrant, timing in PR body | **done** — see table above |
| Funnel oracle reds on an admitted offender | **done** — `funnel.paid_cents_mismatch`, live. Note: 3 of 4 `expect` flips were killed by stage 0 FIRST; `paidCents` is the only expectation stage 0 cannot derive offline, which is exactly why the funnel oracle exists |
| `--entry registration` resolves to the api path; volume section renders | **green**, volume section present, 0 browser mentions |
| Counts pasted, lint clean | scripts/bench **714/714**, tsc clean, eslint 0 problems |
| PR body lists schema escalation + re-pins | owed — the PR itself is the only thing left |

## Still owed

1. Final reviewer pass over the branch.
2. Open the PR (one PR, product + bench — owner ruling 1; record the deviation
   from the prompt's "PR 0 merged first" acceptance line).
3. Teardown: `seazn-env down --label b03r` **and** `--label b03rbase`;
   `git worktree remove .claude/worktrees/b03r-base`.

## Traps that cost time here — do not re-learn them

- **cwd resets between tool calls.** It bit three times: a vitest run from the
  worktree root collected 0 tests; a `grep` of `.next` searched
  `apps/web/apps/web/.next` and reported a missing attribute that was present;
  and a bench run resolved `scripts/bench/bench.ts` under `apps/web`. Always
  `cd <abs path> &&` in the same call.
- **`npx vitest` here intermittently exits 254** (`ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`)
  and writes NO json. Use `./packages/engine/node_modules/.bin/vitest`. Confirm
  the report was written by THIS run before reading a count.
- `DATABASE_URL=` prefix is required for non-DB vitest, or the repo guard
  refuses to start and nothing runs.
- A product edit needs `seazn-env rebuild --label b03r` before any live run —
  and the rebuild takes longer than a 2-minute foreground budget.
- Agents in this worktree **share the git index**; commit with an explicit
  pathspec, never `git add -A`. One agent's first commit swept up another's
  untracked files.
- **The report directory is the git SHA, not a timestamp.** Committing
  mid-investigation moves it, and the next `sed` reads the PREVIOUS run's
  report while looking exactly like a run that changed nothing. Cost one wrong
  diagnosis here: a guard was added, the run re-executed, and the "unchanged"
  error being read was three commits stale. Always resolve the directory from
  the run's own log (`grep -o 'bench-report/[a-f0-9]*' ... | tail -1`).
- **A mutant that breaks COLLECTION reads as survived.** One mutation here
  reported `failed 0 / 629` against a real total of 714 — 85 tests never ran.
  Compare the TOTAL, not just the failure count.
- **A mutant can be a bad probe and still compile.** Gating the Connect release
  on `errors.length === 0` looked like "release only on the happy path" and
  survived — because the outer `catch` pushes to `errors` AFTER the `finally`
  runs, so the gate was always true. The finally was genuinely tested; the
  mutant was not testing it. Re-run with a flag set at the end of the `try`.
- **`tsconfig.scripts.json` excludes `scripts/**/*.test.ts`**, so a bench test
  fixture missing a newly-required field never surfaces in tsc — only when the
  suite runs.
