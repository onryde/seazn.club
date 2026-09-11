# B06b — the darts pack (suite 11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Author suite 11 — org "PDC Worlds", two `generic` divisions built from primary-source darts results — and drive it through the whole bench pipeline, proving the playbook the next nine pack sessions depend on.

**Architecture:** A deterministic builder (`scripts/bench/packs/build-packs/suite11.ts`) transforms two committed research datasets into `scripts/bench/packs/suite11.json`, validated by a drift test exactly as `_tiny` is. The suite is then one row in `SUITE_REGISTRY` — B06a made adding a pack a data change, not a code change.

**Tech Stack:** TypeScript under `node --experimental-strip-types` (no `enum`, no `namespace`, every relative import carries `.ts`), zod 4.4.3, vitest.

**Spec:** `docs/superpowers/specs/bench-product-value/designs/2026-09-09-b06-pack-pilot-design.md` (owner-approved, D1–D8). Programme rules: `bench-prompts/_RULES.md` → `_PACK-PLAYBOOK.md` → `_INDEX.md`. Suite sheet: `bench-prompts/B06-pack-darts-pilot.md`.

## Global Constraints

- **PackSchema FREEZES when this wave merges.** After merge, changes are additive-only and require owner escalation in the PR. Anything to be *removed* from the schema must be removed in this wave or never.
- **The oracle direction is sacred** (`_RULES.md` §3): packs carry raw events; the engine derives outcomes. No helper writes an outcome or verdict into the DB, and no expected value is fed to the product as an input.
- **Stage 0 before HTTP, always.** A pack whose streams do not fold to its own expected results must die offline in seconds.
- **Never invent an attributed fact.** An unattributable fact is a §7A adaptation recorded in `meta.adaptations[]`, not an invention. Reconstructions are flagged `provenance: "reconstructed"`; suite 11 is `real` throughout.
- **Gates vs measurements:** correctness reds the run; timings NEVER do. Do not add a wall-time assertion. The throughput figure this pack records is a FLOOR; B08 owns the real measurement.
- Runtime: no TS `enum`, no `namespace`, no emit-dependent syntax. Engine imports are subpath-only; nothing imports from `apps/web` or `@seazn/engine/testkit`.
- Bench report/CLI strings are i18n-exempt (dev tool). This wave adds nothing to the app, so no locale work is owed.
- Gate command (the `apps/web` suite and `turbo` never see `scripts/bench`):
  ```
  ./packages/engine/node_modules/.bin/vitest run --reporter=json \
    --outputFile=/tmp/b06b.json --testTimeout=30000 scripts/bench
  ```
  Then `npm run typecheck:scripts` (expect 0) and `rtk proxy npm run lint:scripts` (expect no `✖`). Judge green ONLY from the JSON reporter's `numPassedTests`/`numTotalTests` — rtk summaries print `PASS(0) FAIL(0)` for a suite that failed to COLLECT.
- `strip-types-loadable.test.ts` generates one case per bench MODULE, so each new `lib/**.ts` or `build-packs/**.ts` file adds one test. Counts rise by more than the tests written.

---

## The research datasets (already gathered, already verified)

Both live under `scripts/bench/packs/build-packs/data/` and are committed in Task 1.

**`suite11-pdc-worlds-2025.json`** — 2025 PDC World Darts Championship (15 Dec 2024 – 3 Jan 2025, Alexandra Palace).
- 96 players, 32 seeds, 95 matches (R1 32, R2 32, R3 16, R4 8, QF 4, SF 2, F 1).
- 431 sets, 1,779 legs. One walkover (match 35, Ian White w/o Sandro Eric Sosing, medical withdrawal, no darts thrown).
- 28 sessions over 16 playing days; 4 no-play days (24, 25, 26, 31 December).
- Verified: 0 round-format violations, 0 set-score reconciliation failures, all 32 R2 matches pair exactly one seed against one R1 winner, every round's entrants are the prior round's winners.
- Spot-checked against ESPN, Sky Sports and the PDC schedule of play — sources the researcher did not use. All four quarter-finals and the whole opening night reconcile exactly.

**`suite11-pdc-womens-series-2024.json`** — PDC Women's Series 2024, Event 1 (23 Mar 2024, Wigan).
- 111 entrants, 127 rows = 110 contested matches + 17 byes. 584 legs.
- Final: Fallon Sherrock 5–4 Beau Greaves.
- Board numbers and match times are being merged in by a follow-up pass (Task 5 consumes them).

**Cross-division overlap — the careers oracle's subject:** Fallon Sherrock and Noa-Lynn van Leuven appear in BOTH divisions. Sherrock won Div B and lost in Div A's first round. Beau Greaves qualified for the Worlds and declined, so she is Div B only.

**Owner decision on scope (2026-09-11):** Event 1 is taken WHOLE, not trimmed to the Last 32. The suite is therefore ~222 matches / 207 entrants / 205 persons, larger than design §5's ~112-person estimate. The 17 byes are DERIVED (DartConnect records no bye rows; they are the Last-64 entrants who were not Last-128 winners, verified 47 + 17 = 64) and are recorded as a §7A adaptation.

---

## Corrections to the design, found while pinning it

Record these in the PR body. Each was verified against the tree, not assumed.

1. **D1's stream encoding is wrong in a way that matters.** The design says the settling `generic.result` carries `winnerId` and `p1Score`/`p2Score`. But `applyResult` (`packages/engine/src/sports/generic/generic.ts:110-114`) settles from the running tally when the card carries no scores: `const score = hasP1 ? {...} : (state.running ?? null)`. Encoding the totals hands the engine the answer and makes `expected.matches` compare the pack against itself. **The settling card is empty** and the tally decides. This is the difference between a benchmark and a tautology.
2. **`PackStage.bracket` and `PackStage.seeding` are declared and never read.** Grep across `scripts/bench` returns comment matches only. The draw is pinned through `stage.config.slotOrder`, forwarded verbatim at `scripts/bench/lib/seed.ts:638`. See Task 8 for the freeze decision these two fields force.
3. **Design §2.2 no longer holds, in our favour.** `CreateStage.config` is no longer `z.record(z.string(), z.unknown())`. It is `StageConfig`, a `z.strictObject` at `apps/web/src/server/api-v1/schemas.ts:1009-1042` with `byes` (`:1016`) and `slotOrder` (`:1017`) as explicit keys, referenced at `:1057`. A misspelled key now 400s with `unrecognized_keys` instead of being dropped in silence. **D8's separate product PR has already shipped** (#765, merged 2026-09-10) — this wave inherits it. The consequence for the pack: a typo in `stage.config` now fails the whole stage-create call rather than degrading quietly.
4. **A bye fixture omits the away side rather than nulling it** — `bracket.ts:184-186` builds `{...base, home: real, award: real}` with no `away` key at all. Any assertion written against `away === null` will not fire.
5. **`schedule_locked` semantics changed.** A lock is now honoured on EVERY scheduling mode unconditionally (`schemas.ts:1954-2000`); `only_unlocked` no longer gates it and a new `ignore_locks` (`:1998`) is the sole override. The final-session pins therefore hold on any mode the run uses.
6. **`max_fixtures_per_day` moved** to `packages/engine/src/scheduling/constraints.ts:93-97`; the API admits it via an imported `HardConstraint` at `schemas.ts:1668`, not `:1577`.
7. **`_tiny` carries `historicalAssignment: []`.** Suite 11 is the FIRST pack to exercise the feasibility certificate with real data. `lib/certificate.ts` has never run against a populated assignment outside its own unit fixtures — treat a certificate red as a candidate product/bench finding, not a pack bug, until §6.3's order is worked (check the historical assignment against encoded constraints BEFORE reading any solver INFEASIBLE as a finding).

---

## File Structure

| File | Responsibility |
|---|---|
| `scripts/bench/packs/build-packs/data/suite11-pdc-worlds-2025.json` | Raw research input, Div A. Committed, never edited by the builder. |
| `scripts/bench/packs/build-packs/data/suite11-pdc-womens-series-2024.json` | Raw research input, Div B. |
| `scripts/bench/packs/build-packs/data/README.md` | What these files are, where they came from, and the rule that they are inputs rather than outputs. |
| `scripts/bench/packs/build-packs/suite11.ts` | The deterministic builder. Reads both datasets, emits the pack. |
| `scripts/bench/packs/build-packs/__tests__/suite11.test.ts` | Drift gate (builder output == committed pack) plus the raw-data reconciliation guards. |
| `scripts/bench/packs/suite11.json` | The committed pack. |
| `scripts/bench/lib/suites/suite11.ts` | Suite definition: pack path + key. Mirrors `suites/tiny.ts`. |
| `scripts/bench/lib/suites/registry.ts` | One new row. |

---

### Task 1: Commit the research data behind a reconciliation guard

**Files:**
- Commit: `scripts/bench/packs/build-packs/data/suite11-pdc-worlds-2025.json`
- Commit: `scripts/bench/packs/build-packs/data/suite11-pdc-womens-series-2024.json`
- Create: `scripts/bench/packs/build-packs/data/README.md`
- Create: `scripts/bench/packs/build-packs/__tests__/suite11-data.test.ts`

**Interfaces:**
- Produces: the two JSON datasets as committed build inputs; a `RawWorlds` / `RawWomens` type pair exported from the builder in Task 2 for consumers to type against.

- [ ] **Step 1: Write the failing reconciliation test**

The datasets are the pack's ground truth. A guard on them is what stops a later edit from silently changing a result. Every assertion below is derived from the data's own internal structure, never from a table typed into the test.

```ts
// scripts/bench/packs/build-packs/__tests__/suite11-data.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const worlds = JSON.parse(
  readFileSync(fileURLToPath(new URL("../data/suite11-pdc-worlds-2025.json", import.meta.url)), "utf8"),
);
const womens = JSON.parse(
  readFileSync(fileURLToPath(new URL("../data/suite11-pdc-womens-series-2024.json", import.meta.url)), "utf8"),
);

describe("suite 11 raw data — Div A (2025 PDC World Championship)", () => {
  it("has the full 95-match bracket", () => {
    const byRound: Record<string, number> = {};
    for (const m of worlds.matches) byRound[m.round] = (byRound[m.round] ?? 0) + 1;
    expect(byRound).toEqual({ R1: 32, R2: 32, R3: 16, R4: 8, QF: 4, SF: 2, F: 1 });
    expect(worlds.field).toHaveLength(96);
    expect(worlds.seeds).toHaveLength(32);
  });

  it("every played match ends on exactly the round's winning set count", () => {
    for (const m of worlds.matches) {
      if (m.walkover) continue;
      const fmt = worlds.roundFormat.find((r: { round: string }) => r.round === m.round);
      const need = Math.floor(fmt.bestOfSets / 2) + 1;
      expect(Math.max(m.setsP1, m.setsP2), `match ${m.matchNo}`).toBe(need);
    }
  });

  it("per-set leg scores reconcile with the set score", () => {
    for (const m of worlds.matches) {
      if (!m.setScores) continue;
      let a = 0;
      let b = 0;
      for (const set of m.setScores) {
        const [x, y] = set.split("-").map(Number);
        if (x > y) a++;
        else b++;
      }
      expect([a, b], `match ${m.matchNo}`).toEqual([m.setsP1, m.setsP2]);
    }
  });

  it("each round's entrants are exactly the previous round's winners", () => {
    const winner = (m: { winner?: string; p1: string; p2: string; setsP1: number; setsP2: number }) =>
      m.winner ?? (m.setsP1 > m.setsP2 ? m.p1 : m.p2);
    const order = ["R1", "R2", "R3", "R4", "QF", "SF", "F"];
    for (let i = 1; i < order.length; i++) {
      const prevWinners = new Set(
        worlds.matches.filter((m: { round: string }) => m.round === order[i - 1]).map(winner),
      );
      const here = worlds.matches.filter((m: { round: string }) => m.round === order[i]);
      for (const m of here) {
        const fresh = [m.p1, m.p2].filter((n: string) => !prevWinners.has(n));
        // R2 is where the 32 seeds enter; every other round is closed.
        const allowed = order[i] === "R2" ? 1 : 0;
        expect(fresh.length, `${order[i]} match ${m.matchNo}: ${fresh.join(", ")}`).toBe(allowed);
      }
    }
  });

  it("the one walkover carries no scores and says why", () => {
    const wos = worlds.matches.filter((m: { walkover: boolean }) => m.walkover);
    expect(wos).toHaveLength(1);
    expect(wos[0].setScores).toBeNull();
    expect(wos[0].notes).toMatch(/withdrew/i);
  });

  it("every match is scheduled into exactly one session", () => {
    const seen = new Map<number, number>();
    for (const s of worlds.sessions) for (const n of s.matches ?? []) seen.set(n, (seen.get(n) ?? 0) + 1);
    for (const m of worlds.matches) expect(seen.get(m.matchNo), `match ${m.matchNo}`).toBe(1);
    expect([...seen.keys()]).toHaveLength(95);
  });
});

describe("suite 11 raw data — Div B (PDC Women's Series 2024 Event 1)", () => {
  it("is a 128-slot draw with 17 byes", () => {
    expect(womens.field).toHaveLength(111);
    expect(womens.matches).toHaveLength(127);
    expect(womens.matches.filter((m: { p2: string | null }) => !m.p2)).toHaveLength(17);
    // 128 slots: 111 entrants + 17 byes.
    expect(womens.field.length + womens.matches.filter((m: { p2: string | null }) => !m.p2).length).toBe(128);
  });

  it("every contested match ends on exactly the round's winning leg count", () => {
    for (const m of womens.matches) {
      if (m.walkover) continue;
      const fmt = womens.roundFormat.find((r: { round: string }) => r.round === m.round);
      const need = Math.floor(fmt.bestOfLegs / 2) + 1;
      expect(Math.max(m.legsP1, m.legsP2), `match ${m.matchNo}`).toBe(need);
    }
  });

  it("Sherrock won it, over Greaves", () => {
    const final = womens.matches.find((m: { round: string }) => m.round === "F");
    expect(final.p1).toBe("Fallon Sherrock");
    expect(final.p2).toBe("Beau Greaves");
    expect([final.legsP1, final.legsP2]).toEqual([5, 4]);
  });
});

describe("suite 11 raw data — the cross-division career", () => {
  it("names at least one player in both fields", () => {
    const inWorlds = new Set(worlds.field.map((p: { name: string }) => p.name));
    const both = womens.field.filter((p: { name: string }) => inWorlds.has(p.name)).map((p: { name: string }) => p.name);
    // The careers oracle's subject. If this ever empties, the oracle must
    // report NO SUBJECT rather than the pack inventing one.
    expect(both).toContain("Fallon Sherrock");
    expect(both).toContain("Noa-Lynn van Leuven");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd <worktree> && ./packages/engine/node_modules/.bin/vitest run --reporter=json --outputFile=/tmp/b06b-t1.json scripts/bench/packs/build-packs/__tests__/suite11-data.test.ts`
Expected: FAIL — the data files are untracked but present, so this should actually PASS on first run. **That is the point of running it:** it is a guard over data that already exists, not a TDD red. If any case fails, the DATA is wrong and must be fixed before anything is built on it. Record which case failed and why.

- [ ] **Step 3: Write the data README**

```markdown
# suite 11 research inputs

Primary-source datasets behind `packs/suite11.json`. These are INPUTS to
`build-packs/suite11.ts`, never outputs of it — the builder reads them and
never writes them, so a re-run can never launder a hand edit into the pack.

- `suite11-pdc-worlds-2025.json` — 2025 PDC World Darts Championship.
  Wikipedia raw wikitext as primary, with `Template:PDCFlag` expanded for
  nationalities; ESPN and Sky Sports cross-checking the final and semis.
- `suite11-pdc-womens-series-2024.json` — PDC Women's Series 2024 Event 1.
  DartConnect event feeds as primary, Wikipedia corroborating the last eight.

Every gap is declared in each file's `meta.unknowns`. Read it before treating
a missing value as a bug: several absences are facts about what the sources
publish, not omissions. `pdc.tv` is a client-rendered SPA and `pdpa.co.uk`'s
2024 event pages 404 — neither is a usable source, and both were tried.

Guarded by `__tests__/suite11-data.test.ts`, which reconciles set and leg
scores against round formats and walks the bracket round by round.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/bench/packs/build-packs/data scripts/bench/packs/build-packs/__tests__/suite11-data.test.ts
git commit -m "bench(b06b): commit suite 11 research data behind a reconciliation guard"
```

---

### Task 2: The builder skeleton — org, competition, divisions, persons, entrants

**Files:**
- Create: `scripts/bench/packs/build-packs/suite11.ts`
- Create: `scripts/bench/packs/build-packs/__tests__/suite11.test.ts`
- Create: `scripts/bench/packs/suite11.json` (generated)

**Interfaces:**
- Consumes: the two datasets from Task 1.
- Produces: `buildSuite11(): PackInput` and a `main()` that writes the JSON; `refFor(name: string): string` — the one authority mapping a player's printed name to a pack ref, used by every later task.

- [ ] **Step 1: Write the drift test first**

Model it on `build-packs/__tests__/_tiny.test.ts` — a generator, a committed output, and a test that fails when the two disagree.

```ts
// scripts/bench/packs/build-packs/__tests__/suite11.test.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PackSchema } from "../../../lib/pack-schema.ts";
import { buildSuite11 } from "../suite11.ts";

const committed = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../suite11.json", import.meta.url)), "utf8"),
);

describe("suite11 builder", () => {
  it("reproduces the committed pack exactly", () => {
    expect(buildSuite11()).toEqual(committed);
  });

  it("is deterministic across two calls", () => {
    expect(buildSuite11()).toEqual(buildSuite11());
  });

  it("the committed pack is PackSchema-valid", () => {
    const parsed = PackSchema.safeParse(committed);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5), null, 2));
    expect(parsed.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — `Cannot find module '../suite11.ts'`.

- [ ] **Step 3: Write the builder's identity and people layer**

Determinism rules, from `_PACK-PLAYBOOK.md` phase 2: no `Date.now()`, no `Math.random()`, no object-key iteration whose order depends on insertion from a `Set`. Sort every derived collection explicitly.

Naming: **a court, an entrant and an official cannot share a name** — sigil refs resolve in ONE namespace across all three. Darts entrants are individuals named after people, so entrant refs and person refs must not collide either. Use disjoint prefixes.

```ts
// scripts/bench/packs/build-packs/suite11.ts
//
// Suite 11 — "PDC Worlds". Two generic divisions from primary-source results:
// the 2025 PDC World Championship (sets) and PDC Women's Series 2024 Event 1
// (legs). Same module, two granularities — that contrast is the point (D1).
//
//   node --experimental-strip-types scripts/bench/packs/build-packs/suite11.ts
//
// Runtime constraints (bench GLOBAL.md): no TS `enum`, no `namespace`, no
// emit-dependent syntax; every relative import carries `.ts`; engine imports
// are SUBPATH-only.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PackSchema } from "../../lib/pack-schema.ts";

type PackInput = z.input<typeof PackSchema>;

const WORLDS = JSON.parse(
  readFileSync(fileURLToPath(new URL("./data/suite11-pdc-worlds-2025.json", import.meta.url)), "utf8"),
);
const WOMENS = JSON.parse(
  readFileSync(fileURLToPath(new URL("./data/suite11-pdc-womens-series-2024.json", import.meta.url)), "utf8"),
);

/** Printed name -> pack ref. ONE authority: every later step resolves through
 *  this, so a name that appears in both divisions maps to ONE person — which
 *  is exactly what gives the careers oracle a cross-division subject. */
const slug = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

export const personRef = (name: string): string => `p-${slug(name)}`;
export const entrantRef = (division: "a" | "b", name: string): string => `e-${division}-${slug(name)}`;
```

Persons are the UNION of both fields, deduplicated by printed name and sorted for determinism. Entrants are per-division, so Sherrock and van Leuven each yield two entrants pointing at one person.

```ts
function buildPersons(): PackInput["persons"] {
  const names = new Map<string, { name: string; country?: string }>();
  for (const p of [...WORLDS.field, ...WOMENS.field]) if (!names.has(p.name)) names.set(p.name, p);
  return [...names.values()]
    .sort((a, b) => (personRef(a.name) < personRef(b.name) ? -1 : 1))
    .map((p) => ({
      ref: personRef(p.name),
      fullName: p.name,
      lane: "player" as const,
      // countryCode is 3 chars in PackPerson; the datasets carry country NAMES
      // and DartConnect records six players as "United Kingdom" and one as
      // "World". Omit rather than guess a home nation — recorded as an
      // adaptation. A wrong flag is an invented attributed fact.
    }));
}
```

Entrants carry `seed` for Div A's 32 seeds (from `WORLDS.seeds`) and no seed in Div B (the Women's Series draw publishes none).

- [ ] **Step 4: Write the divisions and their stages**

Both divisions are `generic` / `score`. `cfgOverrides` mirrors `_tiny`'s `d-tiny` shape but with `allowDraws: false` — darts cannot draw, and a false draw would be a silent wrong answer rather than a red.

```ts
const GENERIC_CFG = {
  resultMode: "score",
  allowDraws: false,
  points: { w: 3, d: 1, l: 0 },
  progressScore: false,
} as const;
```

Div A's knockout stage pins the draw with `slotOrder` (D4). 128 slots, `null` in each of the 32 bye slots, derived from the bracket: each R2 match names a seed and the R1 match feeding it, which fixes both R1 players' slots and the seed's. `slotOrder` REFUSES being combined with `byeEntrants` (`bracket.ts:130`) and refuses a two-bye pairing (`:148`) — assert both hold before emitting.

Div B's knockout uses `byes` (the 17 named entrants), NOT `slotOrder`: the Women's Series R1 draw positions are not published, so a `slotOrder` there would be an invention. `byeEntrants` must be exactly `nextPowerOfTwo(111) − 111 = 17` or the stage is refused `CONFIG_INVALID` (`bracket.ts:108-120`).

- [ ] **Step 5: Run the drift test to see it fail on content, not on imports**

Expected: FAIL with a diff — `suite11.json` does not exist yet. Write it with `main()`, re-run, expect PASS on the first three cases.

- [ ] **Step 6: Commit**

```bash
git add scripts/bench/packs/build-packs/suite11.ts scripts/bench/packs/build-packs/__tests__/suite11.test.ts scripts/bench/packs/suite11.json
git commit -m "bench(b06b): suite 11 builder — org, competition, two generic divisions, 205 persons, 207 entrants"
```

---

### Task 3: Div A streams — 95 matches, one `generic.score` per set

**Files:**
- Modify: `scripts/bench/packs/build-packs/suite11.ts`
- Modify: `scripts/bench/packs/build-packs/__tests__/suite11.test.ts`

**Interfaces:**
- Consumes: `personRef` / `entrantRef` from Task 2.
- Produces: `streams[]` entries for Div A and the matching `expected.matches[]` rows.

- [ ] **Step 1: Write the failing encoding test**

The encoding is the correction to D1 recorded above, and it is the one thing in this wave that must not be got wrong: the settling card is EMPTY so the engine derives the score from the tally.

```ts
it("Div A encodes one generic.score per set and settles from the tally", () => {
  const pack = buildSuite11();
  const final = pack.streams!.find((s) => s.fixtureExtKey === "wc-f-95")!;
  expect(final.divisionRef).toBe("d-worlds");
  expect(final.provenance).toBe("real");
  const scores = final.events.filter((e) => e.type === "generic.score");
  // Littler 7-3: ten sets, one event each.
  expect(scores).toHaveLength(10);
  expect(scores.filter((e) => e.payload!.by === entrantRef("a", "Luke Littler"))).toHaveLength(7);
  const settle = final.events.filter((e) => e.type === "generic.result");
  expect(settle).toHaveLength(1);
  // EMPTY. `applyResult` (generic.ts:110-114) settles from the running tally
  // when no scores are given. Carrying p1Score/p2Score here would hand the
  // engine the answer and make expected.matches compare the pack to itself.
  expect(settle[0].payload ?? {}).toEqual({});
});

it("every Div A score event names the person who won the set", () => {
  const pack = buildSuite11();
  for (const s of pack.streams!.filter((x) => x.divisionRef === "d-worlds")) {
    for (const e of s.events.filter((ev) => ev.type === "generic.score")) {
      expect(typeof e.payload!.person, `${s.fixtureExtKey}`).toBe("string");
      expect(e.payload!.points).toBe(1);
    }
  }
});

it("the walkover is a one-event stream with an award outcome", () => {
  const pack = buildSuite11();
  const wo = pack.streams!.find((s) => s.fixtureExtKey === "wc-r1-35")!;
  // PackStream requires events.min(1), so a walkover cannot be a stream with
  // no events; it is the settling card alone, naming the winner explicitly
  // because there is no tally to settle from.
  expect(wo.events).toHaveLength(1);
  expect(wo.events[0].payload!.winnerId).toBe(entrantRef("a", "Ian White"));
  const expected = pack.expected.matches!.find((m) => m.fixtureExtKey === "wc-r1-35")!;
  expect(expected.outcome.kind).toBe("win");
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — no Div A streams yet.

- [ ] **Step 3: Implement the stream builder**

```ts
/** One match -> one stream. `core.start` opens it, one `generic.score` per set
 *  won folds the tally, and an EMPTY `generic.result` settles from that tally.
 *
 *  Set ORDER matters and is available: `setScores` lists the sets in play
 *  order, so the tally moves the way the match actually moved rather than
 *  seven wins followed by three losses. A pack that collapses order still
 *  folds to the right total, which is exactly why nothing downstream would
 *  catch it — encode the real order. */
function worldsStream(m: RawWorldsMatch): PackStreamInput {
  const home = entrantRef("a", m.p1);
  const away = entrantRef("a", m.p2);
  if (m.walkover) {
    return {
      divisionRef: "d-worlds",
      fixtureExtKey: extKeyFor(m),
      stageRef: "s-worlds-main",
      home,
      away,
      provenance: "real",
      events: [{ type: "generic.result", payload: { winnerId: winnerEntrant(m) } }],
    };
  }
  const events: PackEventInput[] = [{ type: "core.start" }];
  for (const set of m.setScores!) {
    const [x, y] = set.split("-").map(Number);
    const wonBy = x > y ? m.p1 : m.p2;
    events.push({
      type: "generic.score",
      payload: { by: entrantRef("a", wonBy), points: 1, person: personRef(wonBy) },
    });
  }
  events.push({ type: "generic.result", payload: {} });
  return { divisionRef: "d-worlds", fixtureExtKey: extKeyFor(m), stageRef: "s-worlds-main", home, away, provenance: "real", events };
}
```

`extKeyFor` is `wc-<round lowercased>-<matchNo>` and is the ONE place fixture keys are minted. `seeded.fixtureIdByKey` is keyed by `fixtureKey()` = `JSON.stringify([divisionRef, extKey])` — a hand-built delimiter key misses every entry SILENTLY (B06a finding 21), so never construct one by hand.

- [ ] **Step 4: Add the expected matches**

```ts
function worldsExpectedMatch(m: RawWorldsMatch): PackExpectedMatchInput {
  return {
    divisionRef: "d-worlds",
    fixtureExtKey: extKeyFor(m),
    outcome: m.walkover
      ? { kind: "win", winner: winnerEntrant(m), loser: loserEntrant(m), method: "walkover" }
      : { kind: "win", winner: winnerEntrant(m), loser: loserEntrant(m), method: "regulation" },
    perSide: [
      { entrant: entrantRef("a", m.p1), line: String(m.setsP1 ?? 0) },
      { entrant: entrantRef("a", m.p2), line: String(m.setsP2 ?? 0) },
    ],
  };
}
```

`sideLine` (`generic.ts:196-200`) renders `String(state.score[side])` once the fixture is decided, so `perSide.line` is the set total as a string — the shape `_tiny` already uses.

- [ ] **Step 5: Run the tests, expect PASS, and regenerate the pack**

Run the builder, then the drift test. Both must be green before committing — a regenerated pack and a stale committed one is exactly what the drift test exists to catch.

- [ ] **Step 6: Commit**

```bash
git add -A scripts/bench/packs
git commit -m "bench(b06b): Div A streams — 95 matches, 431 sets, tally-settled results"
```

---

### Task 4: Div B streams — 110 contested matches, one `generic.score` per leg

**Files:**
- Modify: `scripts/bench/packs/build-packs/suite11.ts`
- Modify: `scripts/bench/packs/build-packs/__tests__/suite11.test.ts`

**Interfaces:**
- Consumes: Task 3's `worldsStream` shape, mirrored for legs.
- Produces: Div B `streams[]` and `expected.matches[]`.

- [ ] **Step 1: Write the failing test**

```ts
it("Div B encodes one generic.score per LEG", () => {
  const pack = buildSuite11();
  const final = pack.streams!.find((s) => s.divisionRef === "d-womens" && s.fixtureExtKey.startsWith("ws-f-"))!;
  const scores = final.events.filter((e) => e.type === "generic.score");
  // Sherrock 5-4 Greaves: nine legs.
  expect(scores).toHaveLength(9);
  expect(scores.filter((e) => e.payload!.by === entrantRef("b", "Fallon Sherrock"))).toHaveLength(5);
});

it("the 17 byes carry no stream at all", () => {
  const pack = buildSuite11();
  const byeKeys = new Set(byeFixtureKeys());
  expect(byeKeys.size).toBe(17);
  for (const s of pack.streams!) expect(byeKeys.has(s.fixtureExtKey)).toBe(false);
});

it("one person, two entrants, two divisions", () => {
  const pack = buildSuite11();
  const sherrock = personRef("Fallon Sherrock");
  const hers = pack.entrants.filter((e) => e.roster?.some((r) => r.person === sherrock));
  expect(hers.map((e) => e.divisionRef).sort()).toEqual(["d-womens", "d-worlds"]);
  expect(pack.persons!.filter((p) => p.ref === sherrock)).toHaveLength(1);
});
```

- [ ] **Step 2: Run it to verify it fails**

Expected: FAIL — no Div B streams.

- [ ] **Step 3: Implement**

Identical in shape to Task 3, reading `legsP1`/`legsP2`. **Div B has no per-leg order** — the sources publish leg TOTALS only, not the sequence in which they were won (`meta.unknowns`). Emit the winner's legs first, then the loser's, and record the flattening as a §7A adaptation. This is honest because the tally is order-independent for the final total; the adaptation records that the ORDER is not real, so nobody later reads a Div B stream as a rally sequence.

Div A does not need this adaptation: `setScores` gives real play order.

- [ ] **Step 4: Byes**

A bye is a round-0 fixture the PRODUCT creates from `cfg.byes` — the pack declares the bye entrants and nothing else. Do NOT emit a stream, a `historicalAssignment` row, or an `expected.matches` entry for a bye: the product auto-decides it with an `award` and there is no event to fold. Assert that the bye fixtures come back decided in the live run (Task 9), not in the pack.

Remember `bracket.ts:184-186` omits the `away` key entirely on a bye — an assertion written against `away === null` will not fire.

- [ ] **Step 5: Run tests, regenerate, commit**

```bash
git add -A scripts/bench/packs
git commit -m "bench(b06b): Div B streams — 110 matches, 584 legs, 17 byes declared not streamed"
```

---

### Task 5: Venues, courts, the historical timetable, and the constraint scenario

**Files:**
- Modify: `scripts/bench/packs/build-packs/suite11.ts`
- Modify: `scripts/bench/packs/build-packs/__tests__/suite11.test.ts`

**Interfaces:**
- Consumes: `WORLDS.sessions`, and Div B's board/time data merged by the follow-up research pass.
- Produces: `venues[]`, `historicalAssignment[]`, and each division's `scheduleConfig`.

**This is the task suite 11 exists for.** One court, 95 matches, 16 playing days — the hardest packing case in the roster.

- [ ] **Step 1: Write the failing constraint test**

```ts
it("Div A is one court with two sessions a day", () => {
  const pack = buildSuite11();
  const ally = pack.venues!.find((v) => v.ref === "v-ally-pally")!;
  expect(ally.courts).toHaveLength(1);
  const stage = ally.courts[0];
  // Two PackCourtHours rows per weekday — afternoon and evening. NOT
  // sessionWindows: that field is venue-wide with no court key
  // (api-v1/schemas.ts:1633-1636), so it cannot express "this court, twice
  // a day". The product allows multiple ranges per weekday and 422s only on
  // overlap (usecases/venues.ts:191-200).
  const byWeekday = new Map<number, number>();
  for (const h of stage.hours!) byWeekday.set(h.weekday, (byWeekday.get(h.weekday) ?? 0) + 1);
  for (const [, count] of byWeekday) expect(count).toBe(2);
});

it("the Christmas break is closed-date exceptions, not absent hours", () => {
  const pack = buildSuite11();
  const stage = pack.venues!.find((v) => v.ref === "v-ally-pally")!.courts[0];
  const closed = stage.exceptions!.filter((e) => e.closed).map((e) => e.date).sort();
  expect(closed).toEqual(["2024-12-24", "2024-12-25", "2024-12-26", "2024-12-31"]);
  // A closed exception must OMIT openMin/closeMin (PackCourtException's refine).
  for (const e of stage.exceptions!.filter((x) => x.closed)) {
    expect(e.openMin).toBeUndefined();
    expect(e.closeMin).toBeUndefined();
  }
});

it("the historical timetable covers every played Div A match", () => {
  const pack = buildSuite11();
  const rows = pack.historicalAssignment!.filter((h) => h.divisionRef === "d-worlds");
  expect(rows).toHaveLength(95);
  // startsAt is REQUIRED by PackHistoricalAssignment. Two matches on one court
  // must never share a start, or the certificate reports the REAL timetable as
  // infeasible — a false red that would read as a product bug.
  const perCourt = new Map<string, Set<string>>();
  for (const h of rows) {
    const key = `${h.venue}/${h.court}`;
    const seen = perCourt.get(key) ?? new Set();
    expect(seen.has(h.startsAt), `${key} double-booked at ${h.startsAt}`).toBe(false);
    seen.add(h.startsAt);
    perCourt.set(key, seen);
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

- [ ] **Step 3: Derive Div A's per-match start times, and record the derivation**

The published timetable is SESSION-level: afternoon sessions start 12:30 GMT, evening 19:00, the final 19:30. Per-match clock times are not published — matches run consecutively within a session.

`PackHistoricalAssignment.startsAt` is required, and two fixtures on one court at one time make the certificate report the real timetable as infeasible. So allot each match a slot inside its session, in the session's published match order, at a fixed match length. **Record this as a §7A adaptation** naming exactly what is real (the session, the day, the order) and what is derived (the clock time within the session).

Do not invent a length: derive it from the session's own span and match count so a four-match session and a two-match session differ, and so the derivation moves if the data does.

- [ ] **Step 4: Div B's timetable**

Consume the board/time data from the follow-up research pass. Two branches, and which one applies is a fact about the source, not a choice:
- If DartConnect publishes match START times, use them verbatim and set `court` from the board number. Div B becomes a genuine multi-court packing case with a full certificate.
- If it publishes match END times only, `startsAt` cannot be taken from them without lying. Derive starts by subtracting the published duration where one exists, and where none does, record Div B's certificate as PARTIAL in `meta.adaptations[]` and the report. A derived start presented as real is exactly the invention this pack must not contain.

- [ ] **Step 5: The scheduleConfig, per division**

Div A: `courts: ["@c-ally-pally-stage"]`, a `max_fixtures_per_day` hard constraint at 4, and `schedule_locked` pins on the final session's fixtures. Locks are a FIXTURE field (`schemas.ts:1213`/`:1289`), not a config field, and are now honoured on every mode unconditionally.

Div B: the real board set, one playing day.

- [ ] **Step 6: Run, regenerate, commit**

```bash
git add -A scripts/bench/packs
git commit -m "bench(b06b): the single-court scenario — Ally Pally hours, Christmas closures, historical timetable"
```

---

### Task 6: The expected block — champions, ranks, leaderboards, careers, and the honest absences

**Files:**
- Modify: `scripts/bench/packs/build-packs/suite11.ts`
- Modify: `scripts/bench/packs/build-packs/__tests__/suite11.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it("names both champions", () => {
  const pack = buildSuite11();
  expect(pack.expected.champions).toEqual([
    { divisionRef: "d-worlds", stageRef: "s-worlds-main", entrant: entrantRef("a", "Luke Littler") },
    { divisionRef: "d-womens", stageRef: "s-womens-main", entrant: entrantRef("b", "Fallon Sherrock") },
  ]);
});

it("the sets-won leaderboard is DERIVED from the streams, not typed in", () => {
  const pack = buildSuite11();
  const board = pack.expected.leaderboards!.find((l) => l.divisionRef === "d-worlds" && l.metricKey === "scores")!;
  // Recompute from the pack's own streams. A leaderboard typed by hand freezes
  // whatever the author believed; derived, it moves when the data moves.
  const tally = new Map<string, number>();
  for (const s of pack.streams!.filter((x) => x.divisionRef === "d-worlds")) {
    for (const e of s.events.filter((ev) => ev.type === "generic.score")) {
      const p = e.payload!.person as string;
      tally.set(p, (tally.get(p) ?? 0) + 1);
    }
  }
  for (const entry of board.entries) expect(entry.count).toBe(tally.get(entry.person));
});

it("carries a cross-division career and NO suspensions or specials", () => {
  const pack = buildSuite11();
  const sherrock = pack.expected.careers!.find((c) => c.person === personRef("Fallon Sherrock"))!;
  // Sets won at the Worlds PLUS legs won in the Women's Series — one person,
  // both divisions. This is the oracle the design flagged as a research
  // target rather than an assumption.
  expect(sherrock.metricKey).toBe("scores");
  expect(sherrock.count).toBeGreaterThan(0);
  // Darts has no suspensions and this suite has no special. Both are NO
  // SUBJECT deliberately — an empty array, never a faked row.
  expect(pack.expected.suspensions ?? []).toHaveLength(0);
  expect(pack.expected.specials ?? []).toHaveLength(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

- [ ] **Step 3: Implement, deriving every count from the streams**

`finalRanks` for a knockout is the elimination order; `PackExpectedFinalRanks.order` needs `min(2)` refs. Derive from the bracket: champion, runner-up, then losing semi-finalists, and so on. Where the real tournament does not rank beyond a round (both losing semi-finalists are equal third), the pack must not invent an ordering between them — cut `order` at the last genuinely ordered position and record the cut as an adaptation.

**Averages, 180s and checkouts are not engine-representable at any tier.** Record the drop in `meta.adaptations[]` (§7A) — that is the acceptance item, not a faked metric.

- [ ] **Step 4: Write `meta` — sources and every adaptation**

`meta.synthetic` is `false`. `meta.sources[]` carries every URL from both datasets with `retrievedOn`. `meta.adaptations[]` collects, at minimum: the 17 derived Div B byes; the Div B leg-order flattening; the Div A session-level clock derivation; the omitted `countryCode`s; the dropped averages/180s/checkouts leaderboards; the `finalRanks` cut; and Div B's certificate status if partial.

- [ ] **Step 5: Run, regenerate, commit**

```bash
git add -A scripts/bench/packs
git commit -m "bench(b06b): expected block — champions, derived leaderboards, the cross-division career, honest absences"
```

---

### Task 7: Register the suite and go green offline

**Files:**
- Create: `scripts/bench/lib/suites/suite11.ts`
- Modify: `scripts/bench/lib/suites/registry.ts`
- Create: `scripts/bench/lib/suites/__tests__/suite11.test.ts`

- [ ] **Step 1: Write the failing registry test**

```ts
it("suite 11 is registered and resolvable", () => {
  expect(suiteKeys()).toContain("suite11");
  const def = lookupSuite("suite11")!;
  expect(def.packPath.endsWith("packs/suite11.json")).toBe(true);
  expect(existsSync(def.packPath)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

- [ ] **Step 3: Add the suite module and the registry row**

Mirror `suites/tiny.ts` exactly: resolve the pack path from the MODULE (`fileURLToPath(new URL(...))`), never from `process.cwd()`, and pass both `suiteKey` and `packPath` explicitly — the runner refuses to guess, deliberately (B06a finding 3).

- [ ] **Step 4: Run stage 0 offline against the real pack**

This is the playbook's phase 3 and it must pass before any DB is touched.

```
node --experimental-strip-types scripts/bench/bench.ts --suite suite11 --validate-only
```

Expected: every stream folds; folded per-match outcome equals pack expected for all 205 streams; no error-severity finding. **Gate on `result.ok`, never on "any finding"** — leaderboards, champions and suspensions are NOT derived offline and emit `*.not_derived` WARNINGS by design, so a green run still prints warnings.

- [ ] **Step 5: Run the full bench suite gate**

```
cd <worktree> && ./packages/engine/node_modules/.bin/vitest run --reporter=json \
  --outputFile=/tmp/b06b-t7.json --testTimeout=30000 scripts/bench
```
Paste `numPassedTests`/`numTotalTests` into the task record. Then `npm run typecheck:scripts` and `rtk proxy npm run lint:scripts`.

- [ ] **Step 6: Commit**

```bash
git add -A scripts/bench
git commit -m "bench(b06b): register suite 11; stage 0 green offline"
```

---

### Task 8: The PackSchema freeze

**Files:**
- Modify: `scripts/bench/lib/pack-schema.ts`
- Modify: `docs/superpowers/specs/bench-product-value/bench-prompts/_RULES.md`

PackSchema freezes when this wave merges. Two things must be settled first, and only one of them is mine to decide.

- [ ] **Step 1: Put the dead fields to the owner**

`PackStage.bracket` (`pack-schema.ts:437`, `:452`) and `PackStage.seeding` (`:451`) are declared and read by nothing. After the freeze, removal needs an escalation; right now it is free.

**Recommendation:** delete both. `_tiny` does not use them, suite 11 pins its draw through `stage.config.slotOrder` (D4), and a frozen field with no reader is a trap for the next nine pack authors, who will reasonably assume declaring a bracket does something. If the owner prefers to keep them, they must gain a reader in this wave or a doc comment saying plainly that they are inert and why.

**This is an owner call. Do not decide it inside the wave — ask, and record the answer in the PR body.**

- [ ] **Step 2: Write the freeze note into `_RULES.md` §4**

Replace "PackSchema is FROZEN after B06" with the accurate wave (B06b), the merge SHA once known, and the escalation path. Do not anchor it to a SHA before the final rebase — B06a's session state lost 24 of them to one rebase.

- [ ] **Step 3: Commit**

```bash
git add -A scripts/bench/lib/pack-schema.ts docs/superpowers/specs/bench-product-value
git commit -m "bench(b06b): freeze PackSchema at suite 11"
```

---

### Task 9: The live run — both engine legs, and the report

**Files:**
- Create: `docs/superpowers/specs/bench-product-value/bench-prompts/evidence/b06b-suite11/` (report json + md)
- Modify: `docs/superpowers/specs/bench-product-value/bench-prompts/_INDEX.md`
- Modify: `docs/superpowers/specs/bench-product-value/_MASTER.md`
- Modify: `docs/superpowers/specs/bench-product-value/bench-prompts/_PACK-PLAYBOOK.md`

**The risk this task exists to catch is the inert seam.** B06a's task 9 found a defect that 1,474 green tests could not see — the per-match oracle compared a fixture the run had not folded yet — because every suite-level fake drives `echoExpectedBoard` and satisfies whatever the pack expects by construction. Only the live run can see it. It is mandatory in-wave and is never deferred.

- [ ] **Step 1: Stand up a clean environment**

Follow the `seazn-local-env` skill. `db:apply` alone is NOT a fresh schema — it needs `sync:sports`. Confirm `show data_directory` is yours before trusting any `createdb`.

- [ ] **Step 2: Run leg A — placement service live**

```
node --experimental-strip-types scripts/bench/bench.ts --suite suite11 --engine both --keep
```
Record `solverStatus` per division, the checker's verdict, the certificate result, every oracle verdict, and the throughput floor.

- [ ] **Step 3: Run leg B — no placement container**

CI smoke has no placement container BY DESIGN, and a live service masks greedy/apply-path defects. **The oracle verdicts must be IDENTICAL across both legs** — an oracle that passes only with the solver live is reading the solver rather than the product.

- [ ] **Step 4: Work any certificate red in §6.3 order**

Check the historical assignment against the encoded constraints BEFORE reading any solver INFEASIBLE as a finding. That order is what decides pack-bug vs product-bug, and suite 11 is the first pack to exercise this path with real data at all.

- [ ] **Step 5: Record**

`_INDEX.md`: B06b → DONE, provenance % (expect 100% `real`), the adaptation list, throughput as a FLOOR with B08 named as the owner of the real measurement. `_MASTER.md`: the bench row, and B16's last gate lifting. `_PACK-PLAYBOOK.md`: every correction discovered while executing — **the pilot's real deliverable is a trustworthy playbook**, so a correction left unwritten is the wave's main failure mode.

- [ ] **Step 6: Commit and open the PR**

One PR. Smoke CI runs on PRs only. The PR body carries: the six design corrections above, every unplanned fix, the adaptation list, the mutation-sweep killer LIST if any new comparator logic was touched, and the raw gate counts from the JSON reporter.

---

## Self-review

**Spec coverage.** Design §5's structure (two divisions, both generic), D1 (flat encoding at two granularities — with the settling-card correction), D4 (draw asserted, not assumed), the single-court scenario, the full certificate, all eight oracle rows including the two deliberate NO SUBJECTs, provenance `real` throughout, D7's "no entitlement applies", and the freeze itself each map to a task. §6's product PR is already merged and needs no task. §8's out-of-scope list is respected: no CI wiring, no e2e workflow change, no reconstruction generator, no UI, no browser path.

**Placeholders.** None. Every test step carries runnable code; every implementation step names the exact fields and the file:line the behaviour comes from.

**Type consistency.** `personRef` / `entrantRef` / `extKeyFor` are defined in Task 2 and used unchanged in 3, 4, 5 and 6. `d-worlds` and `d-womens` are the division refs throughout; `s-worlds-main` and `s-womens-main` the stage refs.

**The three named unknowns from design §9** are now answered, and each answer is a recorded finding rather than an assumption: the careers oracle HAS a subject (Sherrock and van Leuven); Event 1 is the best-documented Women's Series event; and one walkover exists (match 35) and is encoded as an adaptation.
