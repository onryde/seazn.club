# W1c HTTP slice — the L3 baseline for parity

`pnpm matrix:l3 --run-id w1c-http-slice --report-dir truth-runs` (harness `b7668c0ff`, base `[local-base]`,
fresh database). Layer L3, driver http, plan `slice`: the six slice cells (league / knockout / swiss ×
generic / badminton) × LIFECYCLE, M1, R4, F1. EXIT 0, 54 s of run time.

| state | cases |
|---|---|
| ✅ works | 24 |

378 checks across the 24 cases; no case is vacuous, and none is an error red.

**Drift check (class 14).** Compared case by case against the committed `../w1b-slice/results.json`: the
same 24 case ids, with the same state for every one. Nothing drifted between W1b's close and this run.

This run is the HTTP side of every W1c parity table:

| browser run | parity header |
|---|---|
| `../w1c-l1/w1c-l1-r1` | compared 6 cases, 102 common checks, 0 differences; 18 HTTP cases outside the browser plan; 0 planned without a harness script (🚫/░) |
| `../w1c-l1/w1c-l1-r2` | compared 6 cases, 102 common checks, 0 differences; 18 HTTP cases outside the browser plan; 0 planned without a harness script (🚫/░) |
| `../w1c-l1/w1c-l1-r3` | compared 6 cases, 102 common checks, 0 differences; 18 HTTP cases outside the browser plan; 0 planned without a harness script (🚫/░) |
| `../w1c-l2` | compared 3 cases, 46 common checks, 0 differences; 21 HTTP cases outside the browser plan; 65 planned without a harness script (🚫/░) |

Parity is not run on the API-only set (controller ruling). That set plans no browser, and it has no HTTP twin.

Forfeit and withdraw: M1 (walkover) and R4 (withdraw) run over HTTP on all six cells. The browser runs them only on
swiss|badminton (see `../w1c-l2/README.md`, carry 8).
