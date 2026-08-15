# ScoringPad v3 — R1 Chassis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the v3 chassis primitives (Scorebug, Ribbon, soft-commit Detail
Dock, Context Strip, Tile Grid, Recording Chip, Swap Sheet), the SkinDef v3
contract + totality-gated registry, and the productized capture harness —
with every v2 sport still rendering through the legacy path, byte-identical.

**Architecture:** Pure spec-builders (node-testable data) + thin renderers,
because apps/web vitest is `environment:"node"` (no jsdom — S11 precedent).
Soft-commit moves the *enqueue→send* moment only; pipeline ack/seq untouched.
No sport converts in R1 — the registry gains a v3 lane beside the legacy lane
and a gate proves totality across both.

**Tech Stack:** Next.js (repo's pinned fork — read `node_modules/next/dist/docs/`
before writing app code), TS7, vitest (JSON reporter only), Playwright,
existing `use-pad-pipeline`/`queue-store`, S7 vocab layer, engine `padSpec`.

**Spec:** `docs/superpowers/specs/2026-08-15-scoringpad-v3-redesign-design.md`
(§2 primitives, §8 register rows D-4, D-5, D-6, D-7, D-11, D-12 partially owed
here). Programme rules: `docs/superpowers/specs/2026-08-15-scoringpad-v3-prompts/_RULES.md`.

## Global Constraints

- Worktree branch `feat/scorepad-v3-r1-chassis`; `pnpm install --frozen-lockfile`;
  `.env.local` symlinks; `readlink -f node_modules/@seazn/engine` must resolve
  inside the worktree.
- Verify with exactly: `npx vitest run --reporter=json --outputFile=/tmp/r.json <paths>`
  then `jq '{total:.numTotalTests,passed:.numPassedTests,failed:.numFailedTests}' /tmp/r.json`.
  `rtk proxy` prefix on every bare tsc/vitest/eslint probe.
- Every new user-facing string: all 4 dictionaries (`en,es,fr,nl`, flat dotted
  keys) + `npm run i18n:gen-keys` leaves `git status --porcelain` empty.
- 44px touch floor; contrast pairs computed from `globals.css` token values in
  a unit test, not eyeballed.
- **Scout re-pins every file:line below before the implementer edits** — all
  pins predate this plan (`registry.tsx` 284 lines, `queue-store.ts` 173,
  `queue.ts` 91, `use-pad-pipeline.ts` 1291, `fidelity-switcher.tsx` 124,
  `attribution-picker.tsx` 261 at capture time).
- Legacy byte-identity bar: existing pad e2e (`scorepad-v2.spec.ts`,
  `scorepad-skins.spec.ts`, `v6-sports.spec.ts`, `carrom-pad.spec.ts`,
  `scoring.spec.ts`) stays green against the R1 build with zero spec edits.

---

### Task 1: SkinDef v3 contract types + pure builders module

**Files:**
- Create: `apps/web/src/components/v2/scorepad/v3/types.ts`
- Test: `apps/web/src/components/v2/scorepad/v3/__tests__/types.test.ts`

**Interfaces (Produces — later tasks and R2+ rely on these exact names):**

```ts
export type TapModel = "S" | "T";
export type PadPhase = "pre" | "live" | "post";

export interface StripItem { label?: string; value: string; accent?: boolean }
export interface WhoLine { name: string; serving?: boolean }
export interface TapEvent { type: string; payload: Record<string, unknown> }

export interface ScorebugHalf {
  who: WhoLine[];
  big: string;                    // pre-formatted, tabular-nums rendering
  hint?: string;                  // i18n key; REQUIRED iff tappable
  tappable?: boolean;             // MODEL-S halves only
  tapEvent?: TapEvent;            // REQUIRED iff tappable
}
export interface ScorebugSpec {
  context: string;                // "T20 · Over 0.5 · RR 14.4" (already localised)
  phase: PadPhase;
  halves: [ScorebugHalf, ScorebugHalf];
  strip: StripItem[];
}

export type TileKind = "primary" | "standard" | "destructive" | "minor";
export interface TileSpec {
  id: string;
  label: string;                  // i18n key
  sublabel?: string;              // i18n key
  kind: TileKind;
  span?: 1 | 2 | 3 | 4;
  phases: PadPhase[];
  action: { event: TapEvent } | { sheet: string } | { swap: true };
}

export interface DockChip {
  id: string;
  label: string;                  // i18n key
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>;
}
export interface DockSpec { title: string; chips: DockChip[] }

export interface ContextSlot {
  id: string;                     // "striker" | "bowler" | …
  label: string;                  // i18n key
  personId?: string;
  pool: "onfield" | "bench" | "all";
  required: boolean;
}
export interface ContextStripSpec { slots: ContextSlot[] }

export interface SheetChoiceStep { id: string; kind: "choice"; title: string; options: { id: string; label: string }[] }
export interface SheetPersonStep { id: string; kind: "person"; title: string; pool: "onfield" | "bench" | "all" }
export type GuidedSheetStep = SheetChoiceStep | SheetPersonStep;
export interface GuidedSheetSpec { event: string; steps: GuidedSheetStep[]; buildPayload: (answers: Record<string, string>) => Record<string, unknown> }

export interface SkinDefV3<View = unknown> {
  key: string;
  tapModel: TapModel;
  scorebug(view: View): ScorebugSpec;
  tiles(view: View): TileSpec[];
  dock(eventType: string, view: View): DockSpec | null;
  context?(view: View): ContextStripSpec | null;
  sheets?: Record<string, GuidedSheetSpec>;
}

export function assertScorebugSpec(spec: ScorebugSpec): string[]; // returns violations
```

- [ ] **Step 1: failing test** — `types.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { assertScorebugSpec } from "../types";

const half = (over: Partial<import("../types").ScorebugHalf> = {}) => ({
  who: [{ name: "A" }], big: "0", ...over,
});

describe("assertScorebugSpec", () => {
  it("accepts a passive spec", () => {
    expect(assertScorebugSpec({ context: "c", phase: "live", halves: [half(), half()], strip: [] })).toEqual([]);
  });
  it("rejects tappable without hint or tapEvent", () => {
    const v = assertScorebugSpec({ context: "c", phase: "live", halves: [half({ tappable: true }), half()], strip: [] });
    expect(v).toContain("halves[0]: tappable requires hint");
    expect(v).toContain("halves[0]: tappable requires tapEvent");
  });
});
```

- [ ] **Step 2: run, expect FAIL** (module not found).
- [ ] **Step 3: implement** `types.ts` — the interfaces above verbatim plus:

```ts
export function assertScorebugSpec(spec: ScorebugSpec): string[] {
  const out: string[] = [];
  spec.halves.forEach((h, i) => {
    if (h.tappable && !h.hint) out.push(`halves[${i}]: tappable requires hint`);
    if (h.tappable && !h.tapEvent) out.push(`halves[${i}]: tappable requires tapEvent`);
    if (!h.who.length) out.push(`halves[${i}]: who must be non-empty`);
  });
  return out;
}
```

- [ ] **Step 4: run, expect PASS** (counts pasted).
- [ ] **Step 5: commit** `feat(scorepad): SkinDef v3 contract types + scorebug spec guard`

### Task 2: Registry v3 lane + totality gate (mutation-proved)

**Files:**
- Create: `apps/web/src/components/v2/scorepad/v3/registry.ts`
- Modify: `apps/web/src/components/v2/scorepad/registry.tsx` (consult v3 lane first — scout re-pins the dispatch site)
- Test: `apps/web/src/components/v2/scorepad/v3/__tests__/registry-totality.test.ts`

**Interfaces:**
- Consumes: `SkinDefV3` (Task 1); engine sport keys via the same import the
  legacy registry already uses (scout pins it; do NOT hardcode the 11).
- Produces: `V3_SKINS: Partial<Record<string, SkinDefV3>>`,
  `LEGACY_SPORTS: ReadonlySet<string>`, `resolvePad(key): {lane:"v3",skin:SkinDefV3}|{lane:"legacy"}`.

- [ ] **Step 1: failing test** — totality over the ENGINE's key list:

```ts
import { describe, it, expect } from "vitest";
import { V3_SKINS, LEGACY_SPORTS, resolvePad } from "../registry";
// scout re-pin: same source of sport keys the legacy registry.tsx iterates
import { ALL_SPORT_KEYS } from "<pinned engine export>";

describe("registry totality", () => {
  it("every engine sport resolves to exactly one lane", () => {
    for (const key of ALL_SPORT_KEYS) {
      const inV3 = key in V3_SKINS;
      const inLegacy = LEGACY_SPORTS.has(key);
      expect(inV3 || inLegacy, `${key} unowned`).toBe(true);
      expect(inV3 && inLegacy, `${key} double-owned`).toBe(false);
      expect(resolvePad(key).lane).toBe(inV3 ? "v3" : "legacy");
    }
  });
  it("unknown key throws — no silent universal fallback", () => {
    expect(() => resolvePad("quidditch")).toThrow(/no pad lane/);
  });
});
```

- [ ] **Step 2: run, FAIL.**
- [ ] **Step 3: implement** — `LEGACY_SPORTS` = all keys (R1 converts none),
  `V3_SKINS = {}`, `resolvePad` as specified; wire `registry.tsx`'s dispatch
  to consult `resolvePad` first (legacy lane = existing code path unchanged).
- [ ] **Step 4: run, PASS.**
- [ ] **Step 5: mutation proof** — `cp` backup, delete one key from
  `LEGACY_SPORTS`, rerun → red (`unowned`); restore from backup (never
  `git checkout`), rerun → green. Paste both counts.
- [ ] **Step 6: commit** `feat(scorepad): v3 registry lane + totality gate`

### Task 3: Ribbon copy builder + i18n keys

**Files:**
- Create: `apps/web/src/components/v2/scorepad/v3/ribbon.ts`
- Modify: all 4 dictionaries (flat keys below)
- Test: `apps/web/src/components/v2/scorepad/v3/__tests__/ribbon.test.ts`

**Interfaces:**
- Produces: `buildRibbon(eventType, payload, names, t): { text: string; undoable: true }`
  where `names: (personId: string) => string` and `t` is the existing vocab
  lookup (scout pins the S7 accessor used by legacy skins — reuse it, do not
  mint a second lookup path; two parallel vocab paths drift).
- New keys (en values; es/fr/nl authored in-session, `i18n:check` gates):
  `pad.ribbon.fallback` = `"{event} recorded"`,
  `pad.ribbon.justNow` = `"just now"`, `pad.ribbon.undo` = `"Undo"`,
  `pad.dock.title` = `"Add detail — optional"`, `pad.dock.clears` = `"clears in {s}s"`.
  Per-event ribbon keys are per-sport (`pad.<sport>.ribbon.<type>`) and land
  with each conversion wave, NOT here — R1 ships the fallback path only.

- [ ] **Step 1: failing test:**

```ts
import { buildRibbon } from "../ribbon";
const t = (k: string, v?: Record<string, string>) =>
  k === "pad.ribbon.fallback" ? `${v!.event} recorded` : k;
it("falls back to the generic ribbon with the vocab'd event name", () => {
  const r = buildRibbon("football.goal", { side: "home" }, () => "?", t as never);
  expect(r).toEqual({ text: "football.goal recorded", undoable: true });
});
```

- [ ] **Step 2: FAIL.** **Step 3: implement** (lookup `pad.<sport>.ribbon.<suffix>`
  first, fallback as tested). **Step 4: PASS.** **Step 5:** add the 5 keys ×4
  locales; `npm run i18n:gen-keys` → porcelain empty. **Step 6: commit.**

### Task 4: Soft-commit queue semantics

**Files:**
- Modify: `apps/web/src/components/v2/scorepad/queue-store.ts` (+`queue.ts`,
  `use-pad-pipeline.ts` send-trigger site — scout re-pins the exact enqueue
  and drain call sites before editing)
- Test: `apps/web/src/components/v2/scorepad/__tests__/soft-commit.test.ts`

**Interfaces:**
- Produces (store API additions — Dock and Undo consume these):
  `enqueueHeld(event, holdMs): id`, `mutateHeld(id, fn): boolean`,
  `releaseHeld(id): void` (send now), `dropHeld(id): boolean` (undo, no core.void),
  `flushHeldBefore(nextTapAt): void` (a new tap releases prior held events).
- Invariants (spec §2.3): held events are DURABLE (survive reload — same
  persistence the queue already has); offline behaviour unchanged; ack/seq
  logic untouched; hold window is a chassis constant `HOLD_MS = 6000`.

- [ ] **Step 1: failing contract tests** (fake timers):

```ts
import { describe, it, expect, vi } from "vitest";
// import the store factory the way its existing tests do — scout pins it
describe("soft-commit", () => {
  it("held event is visible immediately but not sent until the window closes", () => { /* enqueueHeld; expect pending list contains it; expect send spy NOT called; vi.advanceTimersByTime(6000); expect send spy called once */ });
  it("a new tap flushes the previous held event first", () => { /* enqueueHeld A; enqueueHeld B before 6s; expect A sent, B held */ });
  it("mutateHeld lands in the sent payload", () => { /* mutate then advance; sent payload contains mutation */ });
  it("dropHeld removes without send and without core.void", () => { /* drop; advance; send spy never called; no void event enqueued */ });
  it("reload durability: held event survives store rehydrate", () => { /* serialize/rehydrate the store the way queue-store already persists; held entry present with remaining window */ });
});
```

(The implementer fills the arrange/act lines against the re-pinned store
factory — the five assertions above are the acceptance, verbatim.)

- [ ] **Step 2: FAIL.** **Step 3: implement** inside `queue-store.ts` — a
  `heldUntil` field on queue entries + a release tick; the pipeline's drain
  skips entries with `heldUntil > now`. NO second queue. **Step 4: PASS +
  full pre-existing queue/pipeline suites rerun (counts).** **Step 5: commit.**

### Task 5: Scorebug renderer + night-tile tokens + contrast test

**Files:**
- Create: `v3/scorebug.tsx` (thin renderer over `ScorebugSpec`), `v3/tokens.ts`
- Test: `v3/__tests__/contrast.test.ts`

- [ ] **Step 1: failing contrast test** — `tokens.ts` exports the night-tile
  pairs `{bg:"#150b36", fg:"#f5f0e8"}`, `{bg:"#150b36", fg:"#a3e635"}`,
  `{bg:"#1d1145", fg:"#f5f0e8"}`; test computes WCAG ratio (implement
  `contrastRatio(hex, hex)` in the test file from the WCAG formula) and
  asserts ≥ 4.5 for all pairs, and ≥ 3.0 for the lime-on-night large-text
  pair at its actual rendered size class.
- [ ] **Step 2: FAIL (module absent).** **Step 3: implement** `tokens.ts` +
  `scorebug.tsx`: renders halves (tappable ⇒ `<button>` with `minHeight:44`,
  hint text, `aria-label` = who + hint), strip, ONE score render (D-11: the
  consuming page must not add its own — enforced in R2+ conversions).
  **Step 4: PASS.** **Step 5: commit.**

### Task 6: TileGrid + hierarchy

**Files:** Create `v3/tile-grid.tsx`; Test `v3/__tests__/tiles.test.ts`

- [ ] **Step 1: failing test** — pure filter: `tilesForPhase(tiles, "live")`
  excludes tiles whose `phases` lack `"live"` (D-16 mechanism); and
  `assertTileHierarchy(tiles)` returns a violation when >2 `primary` tiles
  are declared for one phase (D-12 mechanism).
- [ ] **Steps 2–4:** FAIL → implement both pure fns + the renderer
  (`minHeight` by kind: 52/52/52/40; destructive = red outline; minor =
  dashed) → PASS. **Step 5: commit.**

### Task 7: Detail dock component wired to soft-commit

**Files:** Create `v3/detail-dock.tsx`; Test `v3/__tests__/dock.test.ts`

- Consumes: `DockSpec` (T1), `mutateHeld`/`releaseHeld` (T4), keys (T3).
- [ ] **Step 1: failing test** — pure controller `dockController(spec, heldId, store)`:
  chip tap calls `store.mutateHeld(heldId, chip.mutate)` exactly once and
  marks the chip selected; dismiss calls `releaseHeld`; controller for a
  `null` spec is `null` (no dock rendered).
- [ ] **Steps 2–5:** implement controller + thin component; PASS; commit.

### Task 8: Context strip + Swap sheet primitives

**Files:** Create `v3/context-strip.tsx`, `v3/swap-sheet.tsx`;
Test `v3/__tests__/context-swap.test.ts`

- [ ] **Step 1: failing tests** (pure):
  `resolvePool(slot, view)` returns on-field/bench/all person lists from the
  view's squad data (scout pins the view-model's squad accessor — the same
  one `attribution-picker.tsx` reads);
  `swapCandidates(view, policyVerdict)` filters by the module's returned
  policy verdict and surfaces `policyVerdict.reason` verbatim when empty
  (spec §2.7 — refusal copy, never a dead control).
- [ ] **Steps 2–5:** implement; components render pickers ≥44px; commit.

### Task 9: Recording chip (fidelity wording)

**Files:** Create `v3/recording-chip.tsx`; Modify 4 dictionaries;
Test `v3/__tests__/recording.test.ts`

- Keys: `pad.recording.band.0` = `"Result only"`, `.1` = `"Cards & key moments"`,
  `.2` = `"Full timeline"`, `.3` = `"Every detail"`,
  `pad.recording.locked` = `"{band} — available on {plan}"` (per-sport
  overrides `pad.<sport>.recording.band.N` land with conversions).
- [ ] **Step 1: failing test** — `buildRecording(fidelity, activeBand, entitledBands, t)`
  returns `{label, locked:false}` for an entitled band and
  `{label, locked:true, upsell}` for `activeBand+1` when unentitled; bands
  come from the module's own `padSpec.fidelity` values (0–3 CLOSED — the test
  asserts a band value of 4 throws).
- [ ] **Steps 2–5:** implement over the pinned entitlement accessor
  (`fidelity-switcher.tsx`'s data source — reuse, don't duplicate); the chip
  REPLACES the four-button picker only when a sport converts (R2+); commit.

### Task 10: Capture harness productized

**Files:**
- Create: `apps/web/e2e/gallery.capture.ts`, `docs/runbooks/pad-gallery.md`

- [ ] **Step 1:** port the session capture spec (recipe + traps in
  `_RULES.md` §2): guarded by `test.skip(!process.env.GALLERY_DIR)` so plain
  e2e runs never execute it; sports table = all 11 + tennis-doubles; states
  01-pre / 02-live / 03-scored / dock / 05-devicelink at 320/768/1280.
- [ ] **Step 2:** run against a local prod server; expect 12 passes and a
  populated `GALLERY_DIR` (file count pasted).
- [ ] **Step 3:** runbook: server bring-up (from `seazn-local-env`), the
  command line, the sign-off gate steps (publish gallery → verdicts →
  walkthrough). **Step 4: commit.**

### Task 11: Legacy byte-identity + wave gate

- [ ] **Step 1:** full apps/web unit gate (JSON counts pasted) + tsc EXIT=0 +
  lint `✖ 0 problems`.
- [ ] **Step 2:** full pad e2e vs a prod build on `localhost` — the five
  legacy spec files listed in Global Constraints, zero edits, green.
- [ ] **Step 3:** run the R1 gallery (Task 10) — screens must be IDENTICAL to
  the baseline captures (no sport converted); spot-diff chess + cricket.
- [ ] **Step 4:** ship checklist from `_RULES.md` §6, including the sign-off
  entry: R1's gallery is evidence of NO visual change; owner ack recorded in
  `_INDEX.md`.
- [ ] **Step 5:** PR `feat/scorepad-v3-r1-chassis` with test-type mapping and
  any `Unplanned fixes`.

---

## Self-review (done at authoring)

Spec coverage: §2.1→T5, §2.2→T3, §2.3→T4+T7, §2.4→T8, §2.5→T6, §2.6→T9,
§2.7→T8, §2.8→T1, registry gate §1→T2, harness §6→T10, D-11/D-12/D-16
mechanisms land here, D-4/D-5/D-6/D-7 land with conversions as specced.
Placeholders: none — contract tests where internals need re-pin carry their
acceptance assertions verbatim. Type consistency: all cross-task names match
Task 1's exports.
