# Swiss shell fixtures + Unpair — organiser walkthrough

> **Spec:** `docs/superpowers/specs/2026-09-18-swiss-shell-fixtures-and-unpair-design.md`  
> **Plan:** `docs/superpowers/plans/2026-09-18-swiss-shell-fixtures-and-unpair.md`  
> **Env:** prod build via `seazn-env up --label swiss-shell-fixtures --all`; browser at `SMOKE_BASE` (typically `http://localhost:3366`).

Checklist for a human or agent driving the **Fixtures** desk (`?tab=fixtures`). Each flow uses a **fresh division** unless noted. Four entrants (even field) unless testing bye behaviour.

---

## Shared setup (every flow)

- [ ] Sign in as an org manager (Pro or Community — Swiss Knockout works on Community).
- [ ] Create competition + division; sport **Generic / Score** (simple result events).
- [ ] Add **four** individual entrants (E1–E4 or Ann–Di).
- [ ] Confirm the Swiss stage has **`config.rounds = N`** before any Generate:
  - Plain Swiss: Settings tab → **Rounds** input, or POST stage with `{ rounds: N }`.
  - Swiss Knockout / Swiss Playoff: wizard **Rounds** knob at create time (template stamps `rounds` on the swiss stage).
- [ ] Open division → **Fixtures** tab; stage rail shows the active Swiss stage.

**Shell math (4 entrants, N rounds):** `N × 2` fixture rows (2 boards per round, no bye). Odd fields add one bye shell per round.

**Stage rail labels (Swiss only):**

| State | Generate button (`data-testid="stage-generate"`) | Unpair (`data-testid="stage-unpair"`) |
| --- | --- | --- |
| No fixtures yet | **Generate fixtures** | hidden |
| Shells minted, unseated round exists | **Pair next round** | visible when latest seated round has **no played results** |
| All rounds seated | **Generate fixtures** (no-op / already paired) | per row above |

Knockout / page playoff / finals stages: **Generate fixtures** only — **no Unpair** button, ever.

---

## Flow 1 — Cold start (plain Swiss)

End-to-end: mint → schedule → Pair → score → Unpair → re-Pair → complete.

### Create & mint

- [ ] Create division with one **Swiss** stage, **Rounds = 3**.
- [ ] **Start division** (or first **Generate fixtures** on an empty swiss stage).
  - **Expect:** API `POST /divisions/{id}/start` returns `generated = 6` (3×2).
  - **Expect:** Run sheet shows **6 rows**, all **TBD vs TBD**, status `scheduled`.
  - **Expect:** Round 1 is **not** auto-paired — sides still null.
- [ ] Stage rail: **Generate fixtures** → **Pair next round** (fixtures exist but unseated).

### Schedule one shell before Pair

- [ ] On a round-1 row (e.g. `sw-r1-b1`), click **Set time** → pick date/time → **Save**.
  - **Expect:** Row shows the chosen time; `GET /fixtures/{id}` has `scheduled_at` set while `home_entrant_id` / `away_entrant_id` remain null.

### Pair & play round 1

- [ ] Click **Pair next round**.
  - **Expect:** Round 1 boards seated (names appear); rounds 2–3 stay TBD.
  - **Expect:** No error / 422 from future unseated shells (`STAGE_NOT_READY` must not fire).
- [ ] Score both R1 matches (enter results on fixture console or pad).
  - **Expect:** R1 fixtures → `decided` / `finalized`.

### Pair, Unpair, re-Pair round 2

- [ ] **Pair next round** → R2 seated, R1 still seated.
- [ ] **Unpair last round** visible → click it.
  - **Expect:** Notice *"Cleared pairings for round 2"* (or locale equivalent).
  - **Expect:** R2 sides cleared back to TBD; R1 still seated and decided.
  - **Expect:** R1 **scheduled_at** (and court if set) **unchanged** on the shell you scheduled earlier.
- [ ] **Pair next round** again → R2 re-seated (pairings may differ from first Pair).
- [ ] Score R2, **Pair next round** for R3, score R3.

### Complete

- [ ] **Complete** stage when all seated fixtures are decided.
  - **Expect:** `POST /stages/{id}/complete` succeeds; stage status complete.
  - **Expect:** Fixture count still **6** — no extra rows minted after start.

---

## Flow 2 — Schedule-ahead

Prove future-round shells accept court/time before any Pair, and schedule survives Pair/Unpair.

- [ ] Plain Swiss, **Rounds = 3**, four entrants, **Start division** (6 shells).
- [ ] Without clicking Pair, schedule **three different shells**:
  - [ ] One R1 board — set time **T1**
  - [ ] One R2 board — set time **T2**
  - [ ] One R3 board — set time **T3**
  - **Expect:** All three show times while sides remain TBD.
- [ ] **Pair next round** (R1 only).
  - **Expect:** R1 seated; R2/R3 shells still TBD but **T2/T3 unchanged**.
- [ ] Score R1 → **Pair next round** (R2).
  - **Expect:** R2 seated; R3 shell still TBD with **T3** intact.
- [ ] **Unpair last round** (R2).
  - **Expect:** R2 sides cleared; **T2** still on that row.
- [ ] Re-Pair R2, score through R3, complete.
  - **Expect:** Every pinned `scheduled_at` still present on its row at end (unless manually edited).

---

## Flow 3 — Unpair gates

When Unpair appears, succeeds, and is refused.

### 3a — Visibility (Swiss)

- [ ] After mint, before any Pair: **Unpair hidden**.
- [ ] After Pair R1, before scoring: **Unpair last round visible** (latest seated = R1, no played results).
- [ ] After scoring R1: **Unpair hidden** (played results block).
- [ ] Pair R2 without scoring: **Unpair visible** again (latest seated = R2).

### 3b — Refuse after result

- [ ] Pair R1, score one board in R1 (partial progress).
- [ ] Attempt **Unpair** (UI should hide) or `POST /api/v1/stages/{swissId}/unpair`.
  - **Expect:** 422 / error — round has played results (`STAGE_NOT_READY` or unpair-failed notice).

### 3b-alt — Bye does not block (odd field)

- [ ] **Five** entrants, **Rounds = 2** → mint includes bye shells (`sw-r*-bye`).
- [ ] Pair R1 → bye row becomes **forfeited** + award winner.
- [ ] **Unpair last round** before scoring any **board** match.
  - **Expect:** Succeeds — Pair-minted bye award is seating, not a played result.
  - **Expect:** Bye shell returns to empty TBD; boards cleared.

### 3c — Swiss-only (no Unpair on KO / finals)

- [ ] **Swiss Knockout** division; complete Swiss half normally.
- [ ] Select **Knockout** stage in rail (seq 2).
  - **Expect:** **No** `data-testid="stage-unpair"`.
- [ ] `POST /api/v1/stages/{koStageId}/unpair` → **422** (*unpair only exists on swiss stages*).

### 3d — Pair blocked on undecided seated round

- [ ] Pair R1 but leave one R1 board **unscored**.
- [ ] Click **Pair next round**.
  - **Expect:** Refused — previous **seated** round still undecided (future TBD shells do **not** cause this block).

---

## Flow 4 — Composite (Swiss Knockout)

Swiss half uses shell mint + Pair/Unpair rules; knockout half unchanged.

- [ ] Create via format picker: **Swiss Knockout**, **Qualify to finals = Top 3**, **Rounds = 3**, four entrants.
  - **Expect:** Stages `[swiss, knockout]`; swiss `config.rounds === 3`, `pairing: rank_adjacent`.
- [ ] On **Knockout** stage (before division start): **Generate fixtures** on KO stage.
  - **Expect:** 3 placeholder bracket rows (bye line + semi + Final), all TBD.
- [ ] **Start division**.
  - **Expect:** Swiss mints **6** empty shells (not R1 paired).
- [ ] Run Swiss half: **Pair next round** between rounds; score so standings are strict (e.g. Ann > Bo > Cy > Di).
- [ ] **Complete** Swiss stage.
- [ ] Knockout: **seed proposal** → confirm.
  - **Expect:** Top **3** qualify; 4th entrant absent from bracket.
  - **Expect:** Bye to Swiss winner; semi is 2nd vs 3rd; Final pre-seated with bye entrant, other side open.
  - **Expect:** Bye row **forfeited** + award on API; half-filled Final stays **scheduled** (not treated as bye).
- [ ] On knockout stage throughout: **no Unpair** control.

### Variant — Swiss Playoff

- [ ] Create **Swiss Playoff** with explicit **Rounds** on swiss stage.
- [ ] Same mint → Pair → schedule-ahead checks on Swiss half.
- [ ] After Swiss completes, playoff / finals stage generates and pairs per existing format rules — **no Unpair** on non-swiss stages.

---

## API quick reference (optional agent path)

| Action | Method | Notes |
| --- | --- | --- |
| Mint all shells | `POST /divisions/{id}/start` or first `POST /stages/{id}/generate` on empty swiss | Requires `config.rounds`; inserts `N × boards` (+ bye if odd) |
| Pair next | `POST /stages/{id}/generate` when shells exist | Seats lowest unseated round |
| Unpair | `POST /stages/{id}/unpair` | Swiss-only; clears latest seated round |
| List fixtures | `GET /divisions/{id}/fixtures` | Filter by `stage_id`; check `round_no`, sides, `scheduled_at`, `outcome` |

---

## Regression smells (stop if seen)

- Generate on empty swiss **without** `rounds` → 422 (not silent forever-pairing).
- First Generate **seats** Round 1 automatically.
- Pair next returns **422** merely because later rounds are unseated TBD shells.
- Unpair on knockout stage succeeds or shows a button.
- Unpair clears **court/time** on shells.
- Fixture **count grows** after initial mint when clicking Pair (should UPDATE existing shells only).
- **Complete** succeeds while a round is still unseated.
