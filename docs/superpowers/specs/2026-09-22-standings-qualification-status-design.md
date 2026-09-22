# Standings qualification status — Phase 1 design

**Status:** owner-approved in conversation, 2026-09-22, section by section.
This file is the design of record; it needs the owner's review before planning starts.
**Depends on:** branch `feat/standings-popovers` (the shared standings popover,
Pts-ratio totals, a tie-break note that can be dismissed), which must be merged first. See §7.

## 1. Problem and audience

A player looking at a standings table asks: *"What do I need to finish in the
top N?"* Right now the table can't answer. It shows ranks and points, but not
whether a place is already won, still open or already lost, or what decides it
when teams finish level on points.

The **audience is players and the public** (owner ruling). The organiser
console shows the **same table** as well (owner ruling R1a) — it is the same
component, so organisers see exactly what players see.

## 2. Owner rulings (not derivable from the code)

| # | Ruling |
|---|---|
| R1 | Audience is players and the public: copy is written for a player. |
| R1a | The organiser console's division standings show the same markers, cut line, legend and popover (owner, 2026-09-22). |
| R2 | Covers **every table stage** with a cut-off: Swiss, league (round robin), and pools feeding a next stage. |
| R3 | The status must never be wrong. Use the **independent-rival bound** (Approach 1). It may be too cautious, but it must never be wrong. The exact late-league check (Approach 2) is a possible follow-up, not Phase 1. |
| R4 | A tie on points at the line is **never** shown as Through or Out. |
| R5 | A what-if target is shown for tie-breaks built from an entrant's own results (point, set and board ratio, difference, points scored), **always labelled** "assumes the rival's figures stay the same". Head-to-head, Buchholz, Sonneborn-Berger and drawing lots get the rule and the current values, never a target. |
| R6 | Layout **Option B**: a cut line plus a marker in the rank cell, and **no new column**. Status, tie note and what-if all live in the one rank popover. |
| R7 | Labels: **Through**, **Win and in** / **Win {k} and in**, **Needs help**, **Out**. The legend groups the middle two as **Still open**. |
| R8 | The **personal "your path" card is deferred to Phase 2** (see §8). |

Mockups (the owner reviewed both and picked B): https://claude.ai/artifact/CgNjHdXGnciKZy1G1FChCi

## 3. The calculation (engine)

New pure module `packages/engine/src/competition/qualification.ts`. It has no
database or UI dependencies.

### 3.1 Input, per table (overall, or one pool)

- `rows`: `{ entrantId, points, active: boolean }[]`. `points` are the table's match points.
- `remaining`: entrantId → the number of matches that entrant has left.
  - **Swiss:** `stage.config.rounds` minus the rounds the entrant has been
    seated in. A bye counts as a round played.
  - **League or pools:** the entrant's unplayed fixtures in that table.
  - Withdrawn or disqualified entrants: `0`.
- `perMatch`: `{ max, min }`. `max` = points for a win (a bye scores as a win,
  `awardByeDelta`). `min` = points for a loss. Both come from the stage's
  `PointsRule` (a stage override, else the division/sport points). A draw's
  points lie between these, so draws need no special case.
- `cut`: `N`, the number of places that qualify from this table.

### 3.2 Output, per active entrant

Let `P` = current points, `r` = remaining matches, and "rival" = any other row,
active or not.
`best(j) = P_j + r_j·max`; `worst(j) = P_j + r_j·min`.

| Status | Rule |
|---|---|
| `through` | `#{ rivals j : best(j) ≥ worst(i) } < N` |
| `out` | `#{ rivals j : worst(j) > best(i) } ≥ N` |
| `win_k` (k = 1..r) | the smallest k with `#{ rivals j : best(j) ≥ P_i + k·max + (r_i−k)·min } < N` |
| `needs_help` | none of the above |

The `≥` in the rules for `through` and `win_k` encodes R4: a rival that can tie
you counts as a rival that can beat you.

**Why it is never wrong:** treating each rival independently allows more
outcomes than can really happen (rivals who meet cannot both win). So every
`through` and `out` also holds over the real outcomes. The cost is only that
it can be too cautious, which R3 accepts.

### 3.3 When no status is shown (the function returns `null` for the table)

- No match in the table has been played yet.
- The stage is complete (`isTableStageComplete`), so qualification is final.
- The cut-off can't be forecast: `picks`, `bestNth`, `roundLosers`, or a
  `rankRange` that doesn't start at 1.
- Per row, `null` for a withdrawn or disqualified entrant. That entrant still
  counts as a rival that can gain no more points.

`topNPerGroup` runs the function once per pool, with `N` = that pool's quota.

### 3.4 The what-if target

A separate pure function, `tieWhatIf(row, rival, cascade, ledger)`, which
returns either a target or nothing.

1. **When it applies:** only when (a) `row` and `rival` sit on opposite sides of
   the line and can finish level on points, and (b) the first cascade key after
   `points` is one of `point_ratio`, `set_ratio`, `board_ratio`, `diff`, `for`.
   Otherwise it returns `{ rule, values }` with no target.
2. **The assumption:** the rival's figures stay as they are, and the entrant
   plays one more match with a total size equal to its average so far
   (`(won + lost) / played`, in that key's own units).
3. **The output:** the smallest net margin that keeps or takes the lead, as
   "win by at least +m" or "lose by no more than m". Ratios, differences and
   points scored all resolve to the same net-margin form.
4. **The rival** is the nearest entrant across the line with whom a tie on
   points is reachable.

## 4. Data flow

### 4.1 Server: shared, cached

The data is the same for every visitor and ISR-cached as today.

- **Migration:** a delta that extends `public_stages_v` with
  `qualify_count`, `qualify_per_group` (boolean), `next_stage_name` and
  `swiss_rounds`. These are derived from the **destination** stage's
  `progression` and from `stages.config.rounds`. The raw `progression` and
  `config` jsonb stay private. (The cut-off is declared on the destination
  stage, `packages/engine/src/competition/progression.ts:33`.) Use the next
  free Flyway number at the time of writing; check the migration tail against
  `main` before committing it.
- **Public read:** `server/public-site/data.ts:901` selects the new columns.
- **Builder:** the standings builder (`server/public-site/standings-view.ts`, and
  the one behind `standings-table.tsx`) calls the §3 functions and emits:
  - per table: `qualification: { cutIndex, label, roundsLeft } | null`;
  - per row: `status`, `ifYouLose`, `tieNote`, `whatIf`. Every string is
    resolved in the org's locale, as today.
- **Caching:** the status rides in the same cached document as the table
  (`revalidate = 30`), so it can never disagree with the points printed
  beside it.

### 4.2 Surfaces

| Surface | Markers, cut line, legend, popover |
|---|---|
| Public division page `app/(public)/shared/[orgSlug]/[competitionSlug]/[divisionSlug]/page.tsx` | yes |
| Competition hub, Table tab (`standings-table-view.tsx`) | yes |
| Embed `app/embed/divisions/[id]/[widget]/page.tsx` | yes |
| Organiser console `app/o/[orgSlug]/c/[compSlug]/d/[divSlug]/page.tsx` | yes (R1a). It is `force-dynamic` and reads stages through its own path, not `public_stages_v` — its builder must feed the same §3 inputs; do not fork the calculation. |

## 5. UI (Option B)

- **Rank cell:** the rank number plus a 16–18px marker:
  - ✓ on a green tint for `through`;
  - an empty dot for `win_k` and `needs_help`;
  - – on a grey tint for `out`, with the row text muted.

  The whole cell is the popover's trigger button, with a tap area of at least
  40px on phones. Its `aria-label` is "Rank {n}, {status}, show details".
- **Cut line:** a full-width row after place N with a dashed accent border and
  the text "Top {N} go through to {next stage} · {r} round(s) left". It may
  wrap to two lines at 320px. For `topNPerGroup`, each pool's table gets its
  own line.
- **Legend:** under the table: Through · Still open · Out · "Tap a rank for
  details." It wraps on phones.
- **Popover:** it extends the shared component from `feat/standings-popovers`.
  Content, in order:
  1. the status headline;
  2. the "if you lose" line;
  3. the tie-break note (the existing one);
  4. the what-if, with its assumption line.

  Behaviour is inherited: it closes on an outside tap or Esc, one is open at a
  time, and on the last rows it opens upward. Maximum width is the screen
  width minus 32px.
- **Phone:** there is no new column, and the Ratio column stays. No horizontal
  page scroll at 320, 768 or 1280.
- **Copy:** every string is a dictionary template in `en`, `es`, `fr` and
  `nl`, with `gen-keys` regenerated afterwards.

## 6. Testing

- **Engine unit tests:**
  - every status on hand-built tables, including a tie exactly at the line,
    byes, draws, `topNPerGroup`, withdrawn rivals, and `r = 0`;
  - `win_k` for k > 1;
  - the no-status cases.
- **Engine brute-force cross-check:** on small random tables (≤ 6 entrants,
  ≤ 2 rounds), enumerate every outcome and assert that every `through` or
  `out` holds in all of them.
- **Mutation checks:** turn each `≥` into `>` and back, drop the tie rule, and
  swap `best` and `worst`. Each change must turn a test red.
- **what-if unit tests:** each key's net-margin output on a case where the
  right answer differs from the average-match constant, and no target for
  head-to-head, Buchholz or lots.
- **Web unit tests:** the builder emits the correct status and wording per
  row, and `null` in each no-status case.
- **E2E on the real public page**, with a Swiss division seeded part-way through:
  - the markers match the statuses and the cut line sits after place N;
  - the popover content is right and closes on an outside tap;
  - the same on the hub Table tab;
  - a pools case with one cut line per pool;
  - the seven-width matrix passes.
- **Console:** an e2e on the organiser division page asserting the same markers and popover as the public page for the same division.
- **Regression:** run the existing standings and hub specs as whole files. A
  division with no cut-off must render exactly as it does today.
- **Smoke:** the public division page loads with the new view columns.
- **Visual:** cropped screenshots at 1280, 768 and 320 of the division page
  and the hub, with a popover open.

## 7. Sequencing

1. Merge `feat/standings-popovers` first. It owns the popover component and
   the rank-cell trigger in both table components.
2. Phase 1 then branches from `main` and extends that popover. Running both
   in parallel would guarantee a conflict on the same lines.

## 8. Out of scope / Phase 2

- **Phase 2, the personal card:** an endpoint `GET /api/v1/me/entrants?division=`
  (account → person → entrant, via `persons.user_id` → `entrant_members`), a
  browser hook following the `analytics-bootstrap.tsx` pattern (the public
  pages are ISR and read no cookies), a "(you)" row, and the card built from
  the viewer's cached row. One card per entrant.
- Approach 2, the exact late-league check.
- `rankRange` cut-offs that don't start at 1 (for example places 5–8 to a
  plate), and `bestNth`.
