# Spectator surface — standing rules

Read this before touching anything under `apps/web/src/app/(public)/shared/**`,
`apps/web/src/components/public-site/**`, `apps/web/src/server/public-site/**`,
`apps/web/src/server/og/**`, or `packages/engine/src/sports/cricket/scorecard*`.
These are rulings that are **not derivable from the code**. Design of record:
`../2026-09-04-spectator-surface-design.md` (its "Standing rules" section R1–R9 is
binding; this file restates them for a subagent that cannot afford the whole spec).

## Who the customer is

The spectator — a player, a parent, a club member, a sponsor — arriving from a
shared link, a QR poster or a search. Second, the organiser whose public face
this is. Every recommendation and finding is stated as value to one of them.
Free orgs carry "Powered by seazn": these pages are also the product's own
acquisition channel, so the share loop is a feature, not chrome.

## The rules

- **R1 — Phone composition, not shrink.** Design at 320/375 first; ≥768 may add
  columns or lay cards two-up, never new controls. Verify with a **control-set
  diff from the live DOM at 320 against 1280** (membership, order, repeats),
  never by comparing box sizes. Scrolling regions carry `tabindex="0"`, a role
  and an accessible name. No page scrolls horizontally at any of
  320/360/375/390/430/768/834. One DOM, branched with `max-md:*` / `md:hidden`
  — never a second phone tree. `/\bmd:hidden\b/` also matches inside
  `max-md:hidden`; anchor assertions on `\s...hidden"`.
- **R2 — Every string through the `public` dictionary namespace, four locales,**
  `gen-keys` regenerated (`i18n-keys.ts` is GENERATED — never hand-edit). Cricket
  column abbreviations (R B 4s 6s SR · O M R W Econ) stay as the sport's own
  notation with localised `title`/`aria-label`. Competition, division, fixture
  and `LiveScore` are hardcoded English today — that is a defect this programme
  removes, not a convention to follow.
- **R3 — Consent before names.** Every person name on a public page or image goes
  through the public-site consent resolver RS008 unified (pin the symbol in
  `server/public-site` before use; do not write a second one). A masked line
  renders the masked label, never a blank row. On a poster a masked performer's
  line is DROPPED, never printed as a mask — a poster is permanent. Youth rule
  as in `fixtureCardModel`.
- **R4 — Fidelity ladder from the engine.** A match's fidelity is the max tier in
  its ledger, read from the engine's own per-type declarations (band closed at
  0–3; "doc 14" in engine comments points at nothing — `module.ts` is the
  authority). Tier 3 → all tabs; tier 2 → Summary + Scorecard + Info; tier 1 →
  Summary (totals) + Info; tier 0 → Summary (result) + Info. **A tab that would be
  empty is not rendered.** No "coming soon".
- **R5 — One authority per fact.** Ball semantics live in the engine cricket
  module; the web app maps, formats, localises. Chase maths (target, required
  rate, projected) sits beside the engine's `chaseTarget` (private today —
  export or wrap; never retype the formula). Format labels ("8-over match") come
  from the sport module's config, not a table in a component.
- **R6 — No new entitlement rows.** Everything here is on every plan. Reuse the
  existing gates only: Realtime on Pro / poll otherwise; `org.branded` for the
  footer. Entitlements v18 is in flight — touch nothing of its matrix or copy
  (the matrix guards red on a missing row).
- **R7 — Testids on every new control** (`mc-…` match centre, `mh-…` matches hub,
  `poster-…`, `gl-…` gallery). Every wave extends
  `apps/web/e2e/walkthrough/spectator-public.spec.ts` in the `walkthrough`
  project (own CI leg). Setup may API to REACH a state; **at least one over of
  the cricket match under test is TAPPED through the real pad**, then read on
  the public page — the pad → ledger → page seam is proven by driving it, not by
  a fixture on both ends.
- **R8 — Share loop.** Every public page has the share bar; the fixture page
  adds poster download (W3). "Powered by seazn" stays on every page and poster
  of a non-branded org.
- **R9 — Empty case first.** Every aggregate (matches filter default, table,
  leaders, top performers, gallery) writes its empty case before its ladder.
  The competition-desk programme shipped three vacuous "Finished" defects past
  green suites from exactly this omission.
- **R10 — Live means live, never reload** (owner, 2026-09-05). Every public
  surface showing a match in play updates IN PLACE: match centre (every tab),
  Live-now rail, Matches hub cards, schedule rows, standings after a result,
  org-home status chips. Transport = the existing pair (Realtime on Pro, poll
  otherwise) carrying the same public JSON the page rendered from. Never a
  "refresh to see the score", never a self-reload. Proof is end to end: post an
  event through the API while the anonymous page is OPEN and assert the DOM
  changes within one poll interval with no navigation. A test that reloads to
  see the change has not tested this rule.

## Repo traps that bite this surface specifically

- `LiveScore` refreshes from an endpoint the scout did not name — pin the URL
  before changing the payload. A payload extended on the server and never read
  by the client is an inert seam (this repo's most repeated failure class).
- `apps/web` vitest is `environment: "node"` — no DOM. Nothing about the tab
  rail, the accordion, the lightbox or the download button is unit-testable;
  the walkthrough and `mobile.spec.ts` projects are the only witnesses.
- `mobile.spec.ts` runs `describe.configure({ mode: "serial" })`: a red count
  there is a FLOOR. Re-run after each fix until a full pass completes.
- A scrolling rail is not clipped content: split on computed `overflow-x`
  (`overflowingIn` / `expectScorebugNotClipped` already do this) and give every
  excused box `tabindex="0"` + role + name, or axe reds at SERIOUS.
- `truncate` needs `min-w-0` on the whole ancestor chain; a 43-character
  entrant name at 320 is the test.
- `entrants.badge_url` may be a column read everywhere and written nowhere —
  prove the crest path with `team_display_v.logo_path` and the monogram fallback
  too, and record the gap rather than absorb it.
- `-g` on a Playwright sweep is a filename sweep in costume. Run whole spec
  files before believing a UI change is clean.
- Assertions on Next HTML anchor on `="` — an omitted prop serialises as
  `"$undefined"`.
- A blown Playwright budget reports itself as a data defect (`Expected 15 /
  Received 14` above the timeout line). Express budgets in the pad's `HOLD_MS`.

## Agents

Scout / Implementer / Reviewer, **Opus at minimum** (owner, 2026-09-04) — model
lives in `.claude/agents/*.md` frontmatter; never pass `model:` on a dispatch.
Loop: Implementer → Reviewer → gap list → … until clean AND green. Every
dispatch carries: exact paths, acceptance criteria (all four test types named),
what NOT to touch, the verify command, an output cap. Never accept "done, tests
pass" without raw JSON-reporter counts; rerun the gate yourself at the wave
boundary. If the account's Opus limit is hit (memory
`project_opus_weekly_limit_hit_20260904`): do not silently downgrade — tell the
owner, and run the settling check (`git log --oneline`, `git status --porcelain`,
report path) on any agent dispatched in the window.

## Environment (label `spx`)

`seazn-env up --label spx` from THIS worktree, never the main checkout. No
standing env: bring it up for a capture or a gate, take it down after (peer
session request, 2026-09-04). The server port moves on every rebuild — re-`eval`
the env script. `db:apply` alone is not a fresh schema (needs `sync:sports`).
Confirm `show data_directory` is yours before trusting a `createdb`.
