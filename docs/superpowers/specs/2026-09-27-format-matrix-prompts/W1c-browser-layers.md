# W1c — browser layers (L1 / L2)

**Goal.** When this wave is done the same scenario scripts that run over HTTP
also run in a real browser: organiser page objects plus one pad adapter per
sport let every cell's lifecycle (L1) and every applicable (format, scenario)
and (sport, scenario) pair (L2) be driven the way an organiser and a scorer
actually drive them. What an organiser gets is the guarantee that a green cell
was clicked, not just posted.

## Read first

- `_RULES.md` (R15, R18, R20, R24) and `_INDEX.md` (rulings 4, 7, 15).
- Design §3 (API-only rows: created over HTTP, then driven in the browser),
  §6.1 (`BrowserDriver`, one scripts catalogue, two drivers), §6.2 (L1/L2
  sizes, mixed-driver lifecycle), §6.4, §11 O3.
- Audits: `audit-2026-09-27/offered-matrix.md` (UI / TPL / API per cell),
  `plan-facts-repo.md` §7 (Playwright config, projects, helpers),
  `plan-facts-api.md`, `plan-facts-sports.md`, `bench-reuse.md` (the bench's
  generic tap adapter).
- `AGENTS.md` "The phone composition" section before touching pad selectors.

## Prerequisites

W1a and W1b merged (design §8 order, R1): the scenario catalogue and L2 pair
file you drive are W1b's committed files.

## Scope

- `BrowserDriver`: organiser page objects + **11 pad adapters** (the bench
  ships only a generic tap adapter).
- L1 framework (every cell × full lifecycle, widths per O3) and L2 framework
  (the committed pair file, widths rotating across the seven).
- Mixed-driver lifecycle (ruling 15): every distinct action type through the
  browser at least once; filler fixtures scored through `HttpDriver`.
- API-only rows (5 rows, 48 cells, plus 2 template-only cells) created over
  HTTP, then driven in the browser; the missing organiser UI is recorded as a ❌
  routed to its named wave (W4 owns the third-place control).
- **Routed gaps: none** (harness wave).

## Lifecycle

No rulebook step (harness wave). §10 steps 4, 5 and 7.

## Decisions owed

- **O3** — L1 widths per cell. Recommended 1280 + 320, with L2 rotating all
  seven; put it to the owner as a recommendation and record the answer.

## Done when

- L1 and L2 run on W1a's vertical slice at the agreed widths, with each pad
  adapter proven by driving its sport's real pad to a finalized result read back
  from the server (R15, R20).
- Every action type in the slice's lifecycle has at least one browser step
  (ruling 15), and the same script produces the same JSON verdict as its
  `HttpDriver` run.
- Whole spec files run, serial files re-run to a full pass (R18); no previously
  green e2e is red; reviewer loop closed.

## Traps

1. **A blown test budget reports itself as a data defect** (class 20). The v3
   pad soft-commits, so each tap waits `HOLD_MS`; express every budget in that
   constant, never a flat timeout.
2. **Folded phone controls** (class 22): at phone widths controls sit behind a
   disclosure. Open every instance, wait on `toBeAttached`, and gate the open on
   the toggle's visibility, not a width literal.
3. **`-g` slices and serial mode lie** (class 21): run whole files; a serial
   file's red count is a floor.
4. **Base URL and cwd**: Playwright runs from `apps/web` with
   `PLAYWRIGHT_BASE`, and the base must be `localhost`, never `127.0.0.1`;
   the config has no `webServer` block by design.
5. **The visual gate's vacuous mode** (class 10): confirm screenshots exist,
   differ between states, and are taken after the state being proven.

## Output and handoff

Update the W1c row and the decision log in `_INDEX.md` as things happen (R22),
including the O3 recommendation and — only once answered — the owner's ruling.
Record per-adapter status (11 sports) so W1d knows which L1 cells can run.
