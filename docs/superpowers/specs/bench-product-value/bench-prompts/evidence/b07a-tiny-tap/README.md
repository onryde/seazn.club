# B07a — `_tiny` live tap-play evidence (Task 13)

Two legs, both real server + real Postgres + real Chromium (Playwright),
per Task 13's dispatch. Neither leg used a `setPlan` shortcut — the plan
each leg tapped against came from the device-link gate probe
(`lib/dls-gate.ts`, B07a T11) reaching the real placement service.

| | leg A (single run) | leg B (concurrent) |
|---|---|---|
| gate | **green** | **green** on both processes |
| oracles | 51/51 pass | 51/51 pass, each process |
| tap play | 4 matches, 24 taps, 16929ms wall | 4/24 each, ~18.4-18.6s wall, started 7ms apart |
| every tapped fixture | `finalized` (`rr-r1-c1`, `rr-r2-c1`, `rr-r3-c1`, `se-r0-i0`) | `finalized`, same four ext-keys, in each process's own org |
| driver observations | 1 (tolerated extra key `person`, see below) | 1 each (same) |
| unread rows after finalize | 0 | 0, both |

## Leg A — `leg-a-single-tap-run/`

One bench process, `--suite _tiny --wipe --engine optimized`, tapping
`d-tiny` live through the generic `TapAdapter` in a real Chromium page.
`preflight.placement.status: "live"` — the run reached the real placement
service at `localhost:50714` and got `READY` within 3s; the plan tapped
against is whatever THAT service returned, not an injected plan.

The report's `tapPlay.observations` count is 1. This is
`comparePayload`'s tolerated-extra-key path (`lib/drivers/scorer.ts:482-483`)
firing for real: one of `d-tiny`'s 24 taps is a solo-scored point, the pad
stamps `{ person: soleScorer }` on it (`generic.tsx:327`), the pack's
`expected` payload for that event does not declare a `person` key, and the
driver logs `tolerated extra key "person" = "<id>"` as an observation
rather than reddening the gate — because `"person"` is on
`GENERIC_TOLERATED_EXTRA_KEYS`. This is **live proof carried item 4's
mechanism actually exercises in a real run**, not just a unit fixture; see
`task-13-report.md` for how the KEY NAME itself (not just the tolerated
value) got pinned as a follow-up regression test. The report/json does not
carry the observation's exact text (`report.ts` caps the field at a count,
by design — a driver observation is informational, not gated); the text
above was recovered from `lib/drivers/scorer.ts`'s own `observations.push`
call site, not re-typed from the run.

## Leg B — `leg-b-concurrent-multi-fixture/`

**Untried lead for the "duplicate-tap trigger" carried item (#2):** the
one lead nobody had tried was CONCURRENT multi-fixture tap play — two
bench processes tapping at the same wall-clock time. Two independent
bench processes were launched against the same running server
(`process-1/`, `process-2/`), each seeding its OWN fresh org (the bench's
default; this does not put two scorers on the literal same fixture row,
only two fixtures on the same wall clock against the same server process —
recorded honestly as a partial test of the lead, not the strongest
possible one).

- `process-1/` and `process-2/`: **both GREEN**, `startedAt` 7ms apart
  (`2026-09-16T13:35:08.942Z` / `.949Z`), `finishedAt` 0.36s apart — genuinely
  concurrent, not sequential. 51/51 oracles pass on each. 0 findings, 0
  unread-after-finalize on each.
- **Result: the trigger was NOT reproduced.** Confirmed independently by a
  direct query against `score_events` after all five runs this session
  (leg A, the two red engine-mismatch attempts, and this concurrent pair):
  zero `(fixture_id, seq)` duplicates across 500 rows. Absence, not proof —
  this bench cannot yet put two scorers on the SAME fixture at the same
  instant (only two fixtures in two orgs at the same wall-clock time), so a
  stronger form of this lead (two device-linked pads racing one fixture) is
  still untried. Recorded as such in `task-13-report.md`.
- `engine-mismatch-footnote/`: the FIRST concurrent-leg attempt, kept only
  as a labelled artifact of a self-inflicted mistake, not as tap-play
  evidence. Both processes were launched with `--engine greedy` while the
  placement service was live, and `--engine` is an ASSERTION the product's
  actual engine choice must match, never a selector (`bench.ts`'s own
  comment) — the live placement service always returns `optimized`
  regardless of the flag, so both processes reported
  `"expected greedy engine, got optimized"` schedule errors and gate=red.
  `tapPlay` on this run still shows 0 findings and 4/24 taps all
  `finalized` — the RED here is entirely the CLI-flag mismatch, not a
  product or driver defect. Re-run immediately after with
  `--engine optimized` (matching the live service) is `process-1`/`process-2`
  above, fully green.

## Screenshots — `screenshots/`

Taken live against the `bencht13` environment (Chromium via Playwright
MCP), proving the parts a report/oracle cannot see by itself:

- `t13-tiny-fixtures.png`, `t13-tiny-standings.png` — the `_tiny` division's
  fixtures tab and standings table after leg A's fold, read by eye.
- `t13-fixture-console.png` — one tapped `_tiny` fixture's console.
- `t13-cricket-scheduled-console.png` — a still-`scheduled` fixture (from
  the DLS-gate probe's own cricket division, same org) used to reach the
  mint/QR/copy panel below, since every `_tiny` fixture was already
  `finalized` by the time this was checked.
- `t13-device-handover-panel.png` — the device hand-over panel before mint.
- `t13-device-link-qr-panel.png` — the minted link's QR + "Copy link"
  panel. The rendered QR was decoded IN BROWSER (Chromium's own
  `BarcodeDetector`, via `page.evaluate`) and its payload matched the
  minted secret's URL (`devicePadUrl()`'s exact shape) character for
  character; the copy button's clipboard content was read back the same
  way and matched too. This closes the QR/copy carried item (#3) — both
  hand-over paths are now proven in a real browser, not just inferred from
  the mint response.
- `t13-device-link-revoked.png` — the same link after "Revoke now",
  confirming the panel reflects the revoke.

Full narrative, per-carried-item verdicts, and the confirmed PRODUCT
FINDING (repeat `POST /stages/{id}/complete` re-running progression) are
in `../../../../../../../.superpowers/sdd/2026-09-11-bench-b07a-match-day/task-13-report.md`
(gitignored — not part of this PR; the path is relative to this README,
from the repo root: `.superpowers/sdd/2026-09-11-bench-b07a-match-day/task-13-report.md`).
