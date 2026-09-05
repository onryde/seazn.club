# W1 — the match centre (public fixture page, every sport; cricket deep)

Read `_RULES.md` → `_INDEX.md` → spec §"The shared model" and §W1:
`../2026-09-04-spectator-surface-design.md`. Plan:
`../../plans/2026-09-04-spectator-w1.md`. Worktree; one PR (may split at the
engine-fold boundary — see "PR shape").

## Why the wave exists

A cricket match on `/shared/…/fixtures/[id]` is a headline and a two-row score.
The parent asks the scorer; the player screenshots the pad; nobody shares the
page. Three of the four reference links the owner sent are scorecard pages.
This wave makes the fixture page a match centre: live header, Summary,
Scorecard, Commentary, Info — for every sport's shell, with cricket's depth
read from the ledger the pad already writes.

## Scope

1. **Engine fold** `packages/engine/src/sports/cricket/scorecard.ts` —
   `deriveCricketScorecard(events, cfg)` per the spec's type, reusing the
   reducer's ball-classification helpers (R5). Tier ladder from the engine's
   declarations (R4). Export or wrap `chaseTarget`; never retype it. Read the
   scoringpad programme's `_INDEX.md` + `_RULES.md`
   (`../2026-08-06-scoringpad-v2-prompts/`) before touching the engine: band
   closed at 0–3, "doc 14" does not exist.
2. **View model** `apps/web/src/server/public-site/match-centre.ts` —
   `buildMatchCentre(fixture, ledger, consent, locale)`; names through the
   consent resolver (R3); dismissal and result text as dictionary keys with
   params; sport-agnostic shell + `cricket?`.
3. **Transport** — pin the endpoint `LiveScore` refreshes from; the public
   fixture JSON carries `matchCentre`; the client re-renders the whole match
   centre — every tab — on push (Pro) or poll (else), in place, never by
   reload (R10, owner ruling 11). Prove the seam by driving it: a smoke
   assertion that the JSON carries the model AND the walkthrough seeing a
   tapped over arrive on an anonymous page that was opened BEFORE the tap and
   never navigated.
4. **UI** `apps/web/src/components/public-site/match-centre/` — header, tab rail
   (`role=tablist`, `tabindex=0`, scroll rail at phone widths), Summary,
   Scorecard (accordion per innings), Commentary (over-grouped, newest first,
   "Load earlier overs"), Info (venue zone via `resolveVenueTz`). Composition
   = **W0 option A** (canvas artboards `Main` for the phone, `DesktopA` for
   1280: court card with LIVE pill / result line and the chase line, then the
   tab rail, then the tab body; desktop lays innings side by side, adds no
   control). One DOM branched with `max-md:*`. Non-cricket: Summary = today's
   `LiveScore` content inside the shell; **Timeline** (ledger newest-first, one
   localised template per engine event type, derived from each module's event
   schemas; a type without a template renders a neutral line); **Sets / Periods**
   (today's `setBreakdown` / `periodBreakdown` promoted to a tab, with per-set
   games or goals-by-period + scorers when the ledger carries them); Info. Owner
   ruling 10 (2026-09-05): every sport gets its depth in THIS wave, not a
   shell. A tab whose ledger has nothing for it is not rendered (R4). Keep the
   shipped dark header bar and tagline strip exactly as they are.
5. **i18n** — every string into `public.matchCentre.*`, four locales, `gen-keys`
   regenerated; a unit test asserts every engine dismissal-enum member has a
   key in every locale.
6. **Meta** — `<title>`/description carry the score when final. OG card unchanged.
7. **Testids** — `mc-*` per spec R7.
8. **Walkthrough v1** `apps/web/e2e/walkthrough/spectator-public.spec.ts` —
   grow it out of the W0 harness `w0-spectator-capture.spec.ts` (its
   `seedAll`/`playInnings` post a valid tier-3 ledger: over/ballInOver derived
   from legal balls as the strict fold expects, `cricket.toss` BEFORE
   `core.start`, short 8-over matches — never a full T20, which takes ~9 min
   through the API). Reach a cricket match mid-innings via the API, TAP one
   over through the real pad (a wide and a wicket in it), then in an anonymous
   context assert
   the over in Commentary, the batter's line in Scorecard and the
   fall-of-wickets entry in Summary at 320 and 1280; a finished match shows the
   result line and top performers; a football fixture shows its goals on
   Timeline and its halves on Sets / Periods with no Scorecard or Commentary
   tab present; one racket-sport fixture shows its sets. Budget expressed in
   `HOLD_MS` terms. Axe pass. Public fixture case
   added to the `mobile.spec.ts` projects for the seven-width no-h-scroll
   check.

## Do NOT touch

The scorepad and its skins; the engine reducer's state shape (the fold is a
SEPARATE pure function — the pad shim hand-copies engine state fields and is
tsc-blind to additions); the organiser console; the landscape OG card;
entitlement matrix/copy; registration pages; the `present` slides.

## Acceptance — all four test types, stated

- **Unit**: fold parity sweep (one scripted two-innings ledger with wides,
  no-balls + free hit, byes, leg byes, penalties, retired hurt, every dismissal
  kind incl. run out with fielder, a maiden, a bowler changing ends, a declared
  innings, a super over) asserting totals against the reducer's `ScoreSummary`
  on the SAME ledger; per-element assertions; mutants listed with the test that
  killed each (delete the wide branch; swap striker/non-striker on a run-out;
  drop the maiden check; flip the tie-break in top performers). View model:
  masking, formatting, dismissal keys × 4 locales, tier ladder with the EMPTY
  ledger stated first, top-performer tie-breaks.
- **E2E**: walkthrough v1 above, green in `--project=walkthrough`; full
  `mobile.spec.ts` file run (never `-g`).
- **Smoke**: `scripts/smoke.ts` gains a public fixture GET asserting `mc-`
  markers and the public fixture JSON carrying `matchCentre`.
- **Regression**: cricket no longer hits the generic long-score fallback
  (`schedule.tsx:62`); a dictionary-coverage assertion over the rendered
  fixture page in all four locales finds zero hardcoded English.
- **Screens**: 320/768/1280 for every tab, live and final, in the PR; control-set
  diff 320 vs 1280 pasted.

## PR shape and gates

One PR. If the review load demands a split at the fold boundary, the fold's PR
still ships its unit sweep PLUS the smoke assertion that the public JSON
carries the model — the seam is never left for "later" (it ships inert every
time). Gates by the orchestrator with JSON-reporter counts; e2e via
`workflow_dispatch` with the PR number; smoke is PR-only; `openapi:gen` drift
clean; `_INDEX.md` status updated in the same PR; final whole-branch review
even when every task review is clean.

## Watch list (re-pin before building)

The `LiveScore` poll URL; the consent resolver symbol; `next/og` is untouched
here; whether `cricket.player.line` (tier 2) carries 4s/6s; how `fixtures`
exposes officials and the toss; `resolveVenueTz`'s signature (competition-desk
programme owns it — import, do not copy).
