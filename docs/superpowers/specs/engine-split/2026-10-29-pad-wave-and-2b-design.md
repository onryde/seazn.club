# Engine split: the pad wave (O-3) and the 2b re-baseline — design

Date: 2026-10-29. Status: **APPROVED by the owner 2026-10-29 ("Ok"), with the recommendations on Q1b and 2b deviations (a)–(d).** The owner chose option A on 2026-10-29 ("ok A, write the spec and
plan"): the pad's rule data moves into the engine, in the monorepo, BEFORE the 2b cutover. This amends the parent spec
`docs/superpowers/specs/2026-10-13-engine-split-design.md` (D10, §2 "Out", §15) and `2026-10-26-owed-work.md` (O-3 order);
§7 of the parent spec stays the cutover recipe, with the deltas in §6 below.

Line numbers are against `origin/main` `17948f93a8` (W2e PR B merged) and must be re-pinned by each task (AGENTS.md
class 5). The counts in §2 come from one read-only scout pass and are a floor, not a total.

---

## 1. Why now, and what it buys

- **The pad is the engine's biggest consumer.** Cutting over with the pad already reading every rule from
  `@seazn/engine` proves the registry install against ~136 real imports, not a fixture (AGENTS.md class 1).
- **82 duplicated rule values are a live drift risk today**, split or no split. When the engine changes a rule the pad
  keeps offering the old one. One copy has already drifted (§5 Q1).
- **After 2b the same work would span two repos and a release per fix.** In the monorepo it is one PR per batch.
- **Capture S2 gets one place to read**: `@seazn/engine/pad`, phone-safe, no React, no DOM, no web i18n (D8).

Cost: W3 starts about one week later. Prod stays held (owner, 2026-10-29), so nothing waits on it.

## 2. What the scout found (origin/main 17948f93a8)

Each rule fact a skin uses, grouped by fact (not by line):

| Sport (file) | (a) reads engine | (b) duplicates engine | (c) skin-only |
|---|---|---|---|
| hockey + icehockey (`period-shared.ts`, `hockey.tsx`, `icehockey.tsx`) | 11 | 12 | 2 |
| football | 5 | 12 | 0 |
| cricket | 7 | 16 | 5 |
| badminton | 5 | 5 | 3 |
| tabletennis | 4 | 7 | 2 |
| volleyball | 7 | 7 | 2 |
| tennis | 4 | 11 | 3 |
| carrom | 3 | 5 | 0 |
| boardgame | 5 | 4 | 0 |
| generic | 3 | 3 | 1 |
| **Total** | **54** | **82** | **18** |

The largest (c) groups are cricket's run and extras values (`RUN_VALUES`, the 5-run penalty, a wide's default 1, the
dock-run arrays, `VARIABLE_OUT_KINDS`); the set-based sports' in-game thresholds (the badminton interval at
`ceil(target/2)`, court parity, golden point and setting in badminton, table tennis and volleyball, and the table tennis
expedite floor of 9); and tennis's 0/15/30/40/AD calls and ends changes.

**Plan re-pin (2026-10-29):** 79 duplicated and 15 skin-only, not 82/18. Cricket's `RUN_VALUES`, `BAT_RUN_VALUES` and
`EXTRA_RUN_VALUES` are dock button presets, not rules (PC-1), and are out of scope; cricket has no `POST_PHASES` copy.
**The engine already describes the pad:** `SportModule.padSpec(cfg)` and `fidelity` (`src/sport/module.ts`) are pure
data on the phone subpaths, so `./pad` derives from them wherever they carry the fact (plan FP-1).

Not counted by the scout, and IN scope here (they are rule facts too): the `POST_PHASES` phase-token set (a copy in
every skin) and the per-field `view.band >= 2` attribution gates. Four (b) rows rest on engine comments the scout did not
trace end to end ("re-entry block", "libero-return", "prevOver", "records refusals"); the owning task traces them first.

Out of scope: presentation (labels, colours, icons, layout, dock button order), web i18n, and `generic`'s
`DOCK_AMOUNTS [2,3,5]` (a button preset, not a rule).

## 3. Design

### 3.1 `@seazn/engine/pad`: one new subpath

- A new export `./pad` in `packages/engine/package.json`, built from `packages/engine/src/pad/index.ts`.
- It is a **facade, not a second source**: each export is a re-export or a pure derivation of a declaration that lives in
  the sport's own module (`src/sports/<sport>/`, the kernels, `src/sport/`). The fold reads the same declaration. No rule
  value is typed twice anywhere in the engine.
- Shape: one frozen record per sport, keyed by the registry's sport key, plus the shared helpers the skins already call
  (`bandsOf`, `eventTypesOf`, `phaseAllows` and so on, re-exported where they already exist).
- **Phone-safe.** `./pad` joins `phone-subpaths.json`'s `subpaths`; its closure is re-pinned in the same PR, and the
  RN-safe gate (`engine:boundary`) covers it. No `node:*`, no React, no strings meant for display.
- Adding a subpath is a minor (parent spec §8). Nothing is published until 2b, so this only matters for the changeset
  the import commit carries.

### 3.2 The (b) items: the skin imports instead of copying

Each skin literal that duplicates an engine declaration is deleted and replaced by an import from `@seazn/engine/pad`.
The UI keeps its own labels and order; only the rule fact moves.

### 3.3 The (c) items: the engine declares them first

Each skin-only fact becomes an engine declaration in the sport's module, exported through `./pad`, and then the skin
imports it.

**Rule: a declaration must not move a fold.** Where the engine already enforces the fact implicitly (for example, a
golden point that the kernel already scores), the declaration is the value the kernel reads, and the golden ledgers
must stay byte-identical. If declaring a fact would change any golden stream, the task stops and raises it as an owner
question; it does not bump `FOLD_EPOCH` on its own (§5 Q2).

### 3.4 What stops it drifting again

- **One drift guard per skin.** A vitest test per sport that drives the skin's offered set (event kinds, sanction levels,
  bounds and so on) and compares it with the `./pad` record, **deriving the expected values from the engine's
  declaration, never a typed table** (AGENTS.md class 19; TEST-STRATEGY), and reporting how many facts it compared (zero
  compared is a failure).
- **One literal guard.** A single source scan over `scorepad/v3/skins/**` that fails on the deleted constant names
  reappearing as local declarations (`const WICKET_KINDS =` and so on). It is a list of names, not a heuristic.
- Each guard is mutated once (re-add one literal; break one re-export) before it is called green.

### 3.5 No behaviour change, proved

- Golden ledgers byte-identical; `FOLD_EPOCH` and `FOLD_MINOR` untouched (except a Q1/Q2 ruling).
- The pad e2e specs that cover the changed skins, by CI dispatch (`scorepad-skins.spec.ts`, `mobile.spec.ts`, the
  per-sport walkthroughs), whole files, never a `-g` slice (class 21).
- The matrix sample on the batch branch.
- **Matrix rows:** none, because the fold does not move; each engine-touching PR body says so.

## 4. Batches

One branch per batch, one PR per batch, each merged on the owner's go. Parallel only where file sets are disjoint.

| Batch | Content | Files |
|---|---|---|
| **P0** | `./pad` subpath skeleton, phone-closure re-pin, the literal guard (empty list) | engine `package.json`, `src/pad/`, `phone-subpaths.json`, one web test |
| **P1** | period sports: hockey, icehockey, football | `period-shared.ts`, `hockey.tsx`, `icehockey.tsx`, `football.tsx`, period kernel, football module |
| **P2** | cricket (largest; carries Q1) | `cricket.tsx`, cricket module |
| **P3** | set-based: badminton, tabletennis, volleyball, plus tennis | four skins, setbased and nested kernels, four modules |
| **P4** | carrom, boardgame, generic; the shared `POST_PHASES`; close the literal list | three skins, three modules |

P1–P4 each depend on P0. P1, P2 and P3 have disjoint file sets and can run in parallel worktrees; P4 last, because
`POST_PHASES` touches every skin. Topology per D30: implementer-sonnet and reviewer-sonnet per task, one Opus review per
batch.

Effort: about one week of calendar time for P0–P4.

## 5. Open questions for the owner (each with a recommendation)

**Q1. Cricket "obstructing the field": does a fielder get credit?** Answered by the house rulebook: yes.
`packages/engine/src/sports/cricket/DOMAIN.md:99` says it "credits the fielder a run out", and the engine matches
(`cricket.ts` `FIELDER_CREDIT_COLUMN`, `obstructed: "runOuts"`). The skin's `FIELDER_ELIGIBLE` is the copy that drifted.
*Recommendation:* the skin gains `obstructed` (it then asks for the fielder); nothing in the engine moves, no epoch.

**Q1b. Who can be out obstructing?** Under Law 37 either batter can, but the skin's `VARIABLE_OUT_KINDS` is only
`["runout"]`. *Recommendation:* if the fold already accepts either batter for `obstructed`, the skin asks "who's out"
for it too, and no fold moves. P2 Task 1 reads the fold and brings both answers before P2 builds.

**Q2. A (c) fact turns out to change a fold.** *Recommendation:* stop and ask, per item; never bump an epoch silently.

**Q3. O-2, the theme contract.** *Recommendation:* still wait for capture S2 to be scheduled. It has no reader until the
native pad exists (inert seam). This wave does not build it.

## 6. 2b: deltas to the parent spec §7

The recipe in parent §7 stands. Changes, from what Phase 2a taught and the owner rulings since:

1. **Order.** Pad wave P0–P4 merges → app tests still reading engine source paths move onto the installed package
   (2b plan Batch R) → `engine-split-base` tag, **with the freeze notice (O-5) at the tag** → baseline Stryker full run
   on that tag (O-6; the mutation session's last full run no longer matches the engine tree after the pad wave) →
   import commit → cutover. The freeze is still about one day.
2. **`scripts/port-engine-branch.sh` is not built** (owner ruling 2026-10-26: no time on non-product scripts). The
   in-flight porting recipe is a three-line `git diff | git apply -p3` note in both repos' AGENTS.md.
3. **The per-PR changed-lines Stryker run (D21) moves after 2b.** It is new tooling, advisory for four weeks anyway, and
   nothing in the cutover needs it.
4. **CI guards stay minimal** (owner ruling 2026-10-26): the `link:`/`file:`, alias-target and re-add checks are one
   grep step each, with no selftest or mutation sweep.
5. **The registry install is proved by real consumers**: `sync-sports` in the stg deploy, the pad e2e by dispatch on the
   cutover branch, and a capture build that bundles `@seazn/engine/pad` under Hermes (parent §7 "Proof").
6. **Prod.** Prod is held (owner, 2026-10-29). Parent §7's rollback window ("engine-repo merges hold until stg plus one
   prod deploy are green") becomes "until stg is green and the owner has run one stg pass of the pad". The first prod
   deploy after 2b ships W2 and the split together; it gets a longer stg soak first.

**Found while planning (2b plan, re-pinned at 17948f93a8):** `onryde/seazn.club.engine` already exists (public, one
README commit, unprotected), so the import commit has a parent; `@onryde/seazn-engine` already exists on GitHub
Packages (private, linked to seazn.club, 28 canaries), so the new repo needs a Write grant before it can publish;
`prod.yml` runs the engine's epoch report, which moves to the engine release.

**2b plan deviations, for the owner (recommendations):** (a) run the baseline and the cold Stryker run in parallel, so
the freeze stays about a day; (b) the testkit ships the golden corpora (reverses D32f for the testkit only); (c) no
temporary freeze CI check (the notice and AGENTS.md line are enough); (d) the epoch report moves to the engine release.

## 7. Decision ledger (this amendment)

| # | Date | Decision | Status | Source |
|---|---|---|---|---|
| D35 | 2026-10-29 | O-3 (pad rule data → `@seazn/engine/pad`) runs in the monorepo BEFORE 2b. Amends D10 and parent §2 "Out". | OWNER | "ok A, write the spec and plan" |
| D36 | 2026-10-29 | Prod held; not on the 2b path. | OWNER | "don't want to go in prod for now" |
| D37 | 2026-10-29 | §6 items 2–4 (no porting script, D21 after 2b, minimal guards) | OWNER | owner ruling 2026-10-26 applied; "Ok" 2026-10-29 |
| D38 | 2026-10-29 | Q1: the skin gains `obstructed` as fielder-eligible (rulebook `DOMAIN.md:99`); no fold change. Q1b: if the fold accepts either batter for `obstructed`, the skin asks who is out; no fold change. | OWNER | "Ok" to the recommendations |
| D39 | 2026-10-29 | 2b deviations (a) baseline and cold Stryker in parallel, (b) testkit ships golden corpora (D32f reversed for the testkit only), (c) no temporary freeze CI check, (d) epoch report moves to the engine release. | OWNER | "Ok" to the recommendations |
| D40 | 2026-10-29 | Pad wave and 2b plans approved; execution per D30. | OWNER | "Ok" |
| D41 | 2026-10-30 | Exception to §3.5 for P3.2: the tennis ends-change cue follows ITF Rule 10 / Rule 5(b) (after odd games, every 6th tie-break point, at the end of an odd-total set, never outside live play) instead of the old skin's reading. A visible pad change; the fold, goldens and epoch do not move. Rule TN-EN-1. | OWNER | owner ruling 244, "yes accept tennis 244" |
| D42 | 2026-10-30 | Exception to §3.5 for P3.1: the set-based deuce/setting note follows the rulebook through the engine's `deuceNote` (badminton Setting at every tie from target−1 to the cap, volleyball Deuce at every tie from 24-all / 14-all deciding, `winBy: 1` Golden point, table tennis unchanged, never outside live play). A visible pad change; the fold, goldens and epoch do not move. Rows BD-SC-1, TT-SC-1, VB-SC-1. | OWNER | owner ruling 243, "apply rec" |
