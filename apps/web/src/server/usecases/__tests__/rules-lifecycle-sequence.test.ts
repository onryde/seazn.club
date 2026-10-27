// W2c Task 22, carry 2 (batch-6 review M-3) - the cross-task SEQUENCE nobody tested: one division with one league stage
// takes, in order, a stage override (T17 putStageRules), the stage's own points (T13/T18, the same door), a match override
// (T19 writeFixtureRulesOverride), a first score event (the stage starts), and a division edit (T20 patchDivision). Every
// task had its own suite; none drove the five on ONE division, so a lock that holds in each door alone could still
// disagree across them (the stage editor offers what the match block, the division form or the pad then refuses).
//
// At each step the test reads what the product's SCREENS read - not the writer's own answer alone:
//   - the stage editor's lock         formatLockedStageIds        (stages-panel)
//   - the match block                 loadFixtureMatchRules       (fixture console "Match rules")
//   - the open scoring pad            loadFixturePadCfg           (cfg + rules_version it appends against)
//   - the division settings form      divisionLockedFields        (lockedFields), against the save's own `refused`
// and the stored rows (stages.config, fixtures.rules_override / rules_version / config_snapshot, divisions.config).
//
// Expected values are NOT read off the code under test. The rig is derived from the engine's own declarations
// (`ruleKeys` scopes, `fixtureKeysFor`, `stageKeysFor`, `pointsKeysFor`, `coverage` over `reachableOutcomes`, the sport's `configSchema`
// and `variants`) and from the signed rows: X-SR-1 (a stage sets only the keys its engine declares), X-SR-2 (a match
// differs from its stage only on match-scoped keys), X-SR-3 (a stage's format locks when any match starts and stays
// locked after a void), X-SR-4 (a division setting locks only when a started stage INHERITS it; the refusal names the
// stage; other settings still save), X-PT-1 (a stage's points rule applies to that stage's table, so it replaces the
// division's win/draw/loss for it). It sweeps the whole sport registry (the sequence is sport-blind code reading each
// sport's declarations, so one sport proves one sport's declarations); a key with no derivation FAILS, never skips.
//
// Sequence cases: the second call (a re-send changes nothing and bumps nothing), the empty case (nothing started: no
// lock anywhere, an empty patch refuses nothing), a sport with no match-scoped key (the per-match door refuses by
// declaration), a sport whose stage can end in an outcome the saved points do not pay (W2d T10: cricket's tie, refused
// POINTS_OUTCOME_UNCOVERED by name; W2c's Q1 "inexpressible" is retired), a division whose rulebook pays an outcome apart
// (W2d T10 fix round 1 I2: IIHF's overtime, FIVB's 3-2, ITTF's loss not played - a FLAT rule is refused
// POINTS_SPLIT_FLATTENED naming the splits, `_points-split-rulebook.ts`, and a rule that states one is saved), and the control division (the same sport started
// with NO pin, a legacy row, locks the table keys the pinned stage frees). Real Postgres (skipped without DATABASE_URL).
//
// W2d Task 10 (spec §5.4): the generated stage is PINNED at activation, so the division's `points` / `pointsMap` and its
// `tiebreakers` no longer reach it and are never refused; `scoring` / `awardScore` keep W2c's lock.
import { afterAll, describe, expect, it } from "vitest";
import { PointsRule, coverage, reachableOutcomes } from "@seazn/engine/competition";
import { RULEBOOK_SPLITS } from "@/components/v2/stage-rules/__tests__/_points-split-rulebook";
import { checkFixtureOverride, fixtureKeysFor, pointsKeysFor, stageKeysFor, type AnySportModule } from "@seazn/engine/sport";
import { sportCases } from "@seazn/engine/testkit";
import { canonicalJson } from "@/lib/canonical-json";
import { sql } from "@/lib/db";
import { getDictionary } from "@/lib/i18n";
import { RULE_ERROR_STATUS, type RefusedField } from "@/lib/rule-errors";
import { appendEvent } from "@/server/engine-db";
import { seedBracket, type SeededBracket } from "@/server/engine-db/__tests__/helpers/seed-bracket";
import { getDivision, patchDivision } from "../divisions";
import { loadFixtureMatchRules, loadFixturePadCfg } from "../fixtures";
import { writeFixtureRulesOverride } from "../fixture-rules";
import { divisionLockedFields } from "../rule-locks";
import { formatLockedStageIds, putStageRules } from "../stage-rules";
import { editorFragments, movingFragments } from "./_stage-probe";

const HAS_DB = !!process.env.DATABASE_URL;
afterAll(async () => {
  if (!HAS_DB) return;
  const g = globalThis as { _sql?: { end(): Promise<void> } };
  const c = g._sql;
  g._sql = undefined;
  await c?.end();
});

// ---------------------------------------------------------------------------------------------------------------------
// The rig: derived from the engine's declarations, per sport.
// ---------------------------------------------------------------------------------------------------------------------

type Moving = { key: string; frag: Record<string, unknown> };
interface Rig {
  readonly variant: string;
  /** The variant's preset as the division stores it. */
  readonly preset: Record<string, unknown>;
  /** The key the STAGE sets itself (T17), moved off the preset. */
  readonly stageKey: Moving;
  /** A key the stage does NOT set: it inherits the division's, so a started stage locks it for the division (X-SR-4). */
  readonly inheritedKey: Moving;
  /** A plain match-scoped key one match may differ on (X-SR-2), or null when the sport declares none. */
  readonly matchKey: Moving | null;
  /** Every match-scoped top key the sport declares for a league stage (empty = the per-match door must refuse all). */
  readonly matchTops: readonly string[];
}

const topOf = (key: string): string => key.split(".")[0]!;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b);
const subsets = <T,>(xs: readonly T[]): T[][] => xs.reduce<T[][]>((acc, x) => [...acc, ...acc.map((s) => [...s, x])], [[]]);

/** `bestOf` is answered by the division's `pointsMap` (D10) - its own door-level rule with its own tests (stage-rules.test.ts) -
 *  so a sequence about locks does not move it. */
const SKIPPED_KEYS: ReadonlySet<string> = new Set(["bestOf"]);

function deriveRig(m: AnySportModule): Rig {
  const variant = Object.keys(m.variants)[0]!;
  const preset = m.variants[variant] as Record<string, unknown>;
  const deciderTop = (top: string) => Object.entries(m.ruleKeys ?? {}).some(([k, f]) => topOf(k) === top && f.decider === true);
  const deciders = (xs: Moving[]) => [...xs.filter((x) => !deciderTop(x.key)), ...xs.filter((x) => deciderTop(x.key))];
  const moves = deciders(movingFragments(m, variant, "league").filter((x) => !SKIPPED_KEYS.has(x.key)));
  const matchTops = [...new Set(fixtureKeysFor(m, "league", variant).map(topOf))];
  const parsedPreset = m.configSchema.parse(preset) as Record<string, unknown>;
  // A match key: a plain one whose editor fragment moves the preset and that the engine's own X-SR-2 check accepts.
  const matchOk: Moving[] = [];
  for (const top of matchTops) {
    if (SKIPPED_KEYS.has(top) || deciderTop(top)) continue;
    for (const frag of editorFragments(m, variant, top)) {
      const now = m.configSchema.parse({ ...preset, ...frag }) as Record<string, unknown>;
      if (same(now[top], parsedPreset[top])) continue;
      matchOk.push({ key: top, frag });
      break;
    }
  }
  const valid = (parts: Moving[]) =>
    subsets(parts).every((s) => m.configSchema.safeParse({ ...preset, ...Object.assign({}, ...s.map((x) => x.frag)) }).success);
  const matchChoices: (Moving | null)[] = matchTops.length === 0 ? [null] : matchOk;
  for (const matchKey of matchChoices) {
    for (const stageKey of moves) {
      if (stageKey.key === matchKey?.key) continue;
      for (const inheritedKey of moves) {
        if (inheritedKey.key === stageKey.key || inheritedKey.key === matchKey?.key) continue;
        if (!valid([stageKey, inheritedKey, ...(matchKey ? [matchKey] : [])])) continue;
        if (matchKey !== null) {
          const stageResolved = m.configSchema.parse({ ...preset, ...stageKey.frag }) as Record<string, unknown>;
          if (!checkFixtureOverride(m, "league", variant, stageResolved, matchKey.frag).ok) continue;
        }
        return { variant, preset, stageKey, inheritedKey, matchKey, matchTops };
      }
    }
  }
  throw new Error(`${m.key}: no rig derived (moving stage keys ${moves.map((x) => x.key).join(",")}; match keys ${matchTops.join(",")})`);
}

/** The engine's parse of the preset with the fragments laid over it: what the format resolves to. */
const resolved = (m: AnySportModule, rig: Rig, ...frags: Record<string, unknown>[]): Record<string, unknown> =>
  m.configSchema.parse({ ...rig.preset, ...Object.assign({}, ...frags) }) as Record<string, unknown>;

/** A division-level change to a table key a stage's own points replace (X-PT-1), where the sport's points have a shape to
 *  move: `points.win + 1`, or the first pair of `pointsMap`. Null where neither moves under the sport's schema. */
function movedTablePatch(m: AnySportModule, cfg: Record<string, unknown>): { key: "points" | "pointsMap"; value: unknown } | null {
  const p = cfg.points;
  if (isObj(p) && typeof p.win === "number") {
    const value = { ...p, win: p.win + 1 };
    if (m.configSchema.safeParse({ ...cfg, points: value }).success) return { key: "points", value };
  }
  const pm = cfg.pointsMap;
  if (isObj(pm)) {
    const k = Object.keys(pm)[0];
    const pair = k === undefined ? undefined : pm[k];
    if (k !== undefined && Array.isArray(pair) && typeof pair[0] === "number") {
      const value = { ...pm, [k]: [pair[0] + 1, ...pair.slice(1)] };
      if (m.configSchema.safeParse({ ...cfg, pointsMap: value }).success) return { key: "pointsMap", value };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Readers (the stored rows)
// ---------------------------------------------------------------------------------------------------------------------

const stageConfig = async (id: string): Promise<Record<string, unknown>> =>
  (await sql<{ config: Record<string, unknown> }[]>`select config from stages where id = ${id}`)[0]!.config;
interface FixtureRow {
  rules_override: Record<string, unknown> | null;
  rules_version: number;
  config_snapshot: unknown;
  status: string;
}
const fixtureRow = async (id: string): Promise<FixtureRow> =>
  (await sql<FixtureRow[]>`select rules_override, rules_version, config_snapshot, status from fixtures where id = ${id}`)[0]!;
const divisionConfig = async (b: SeededBracket): Promise<Record<string, unknown>> => ((await getDivision(b.auth, b.divisionId)).config ?? {}) as Record<string, unknown>;
const rulesOf = (c: Record<string, unknown>): Record<string, unknown> | null => (c.rules as Record<string, unknown> | undefined) ?? null;

/** The refusals a division save names, as the division settings form lists them (`lockedFields`). */
const entryFor = (list: readonly RefusedField[], field: string): RefusedField | undefined => list.find((r) => r.field === field);

const START = { type: "core.start", payload: {} } as const;
const BASE_POINTS = { win: { regulation: 3 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const };
const SECOND_POINTS = { win: { regulation: 2 }, draw: 1, loss: { regulation: 0 }, shootoutAs: "result" as const, unit: "whole" as const };

// What the sweep witnessed: zero in any branch is a failure (anti-vacuity), not a pass.
const seen = {
  sports: new Set<string>(),
  matchSaved: new Set<string>(),
  matchRefusedByDeclaration: new Set<string>(),
  pointsSaved: new Set<string>(),
  pointsRefusedUncovered: new Set<string>(),
  pointsRefusedFlat: new Set<string>(),
  tableSaveWitnessed: new Set<string>(),
  keptNamed: new Set<string>(),
  controlLocked: new Set<string>(),
  controlOwed: new Set<string>(),
  voidKeptLock: new Set<string>(),
};

describe.skipIf(!HAS_DB)("one division, one stage: override, points, match override, start, division edit (batch-6 M-3)", () => {
  for (const { key, module: m } of sportCases()) {
    it(`${key}: each step's lock, refusal code and stored value, read through the screens' own predicates`, async () => {
      const rig = deriveRig(m);
      const dict = await getDictionary("en", "public");
      const b = await seedBracket({ sport: key, variant: rig.variant, stageKind: "league", entrants: 3 });
      const [fixA, fixB] = b.fixtureIds as [string, string];
      const stageName = "S1";

      // ---- the empty case: generated, nothing started --------------------------------------------------------------
      const rules0 = rulesOf(await stageConfig(b.stageId));
      expect(await formatLockedStageIds(b.auth, b.divisionId), "nothing started: the stage editor offers the editor").toEqual([]);
      expect(await divisionLockedFields(b.auth, b.divisionId), "nothing started: the division form locks nothing, though fixtures exist").toEqual([]);
      expect((await patchDivision(b.auth, b.divisionId, {})).refused, "an empty patch refuses nothing").toEqual([]);
      const noop = await putStageRules(b.auth, b.stageId, {});
      expect(noop.points, "an empty body leaves the points as stored (none)").toBeNull();
      expect(noop.rules !== null ? canonicalJson(noop.rules) : null, "an empty body leaves the rules as stored").toBe(rules0 !== null ? canonicalJson(rules0) : null);
      const versionA0 = (await fixtureRow(fixA)).rules_version;

      // ---- 1. the stage's own override (T17) -----------------------------------------------------------------------
      const withStage = await putStageRules(b.auth, b.stageId, { rules: rig.stageKey.frag });
      const rulesStage = { ...(rules0 ?? {}), ...rig.stageKey.frag };
      expect(canonicalJson(withStage.rules), `${rig.stageKey.key}: the answer is the stage's merged rules`).toBe(canonicalJson(rulesStage));
      expect(canonicalJson(rulesOf(await stageConfig(b.stageId))), "stored at stages.config.rules").toBe(canonicalJson(rulesStage));
      expect((await fixtureRow(fixA)).rules_version, "an unstarted match whose format the save moved is re-versioned (X-SR-7)").toBe(versionA0 + 1);
      // the second call: a re-send changes nothing and bumps nothing
      const again = await putStageRules(b.auth, b.stageId, { rules: rig.stageKey.frag });
      expect(canonicalJson(again.rules), "second call: same rules").toBe(canonicalJson(rulesStage));
      expect((await fixtureRow(fixA)).rules_version, "second call: no new version").toBe(versionA0 + 1);
      expect(await formatLockedStageIds(b.auth, b.divisionId), "saving a stage's rules does not start it").toEqual([]);

      // ---- 2. the stage's own points (T13/T18), the same door ------------------------------------------------------
      // The engine's own answer to "does this rule pay every outcome the stage can end in" (spec §5.4), on the stage's cfg.
      const want = coverage(PointsRule.parse(BASE_POINTS), reachableOutcomes(m, resolved(m, rig, rig.stageKey.frag), "league"));
      // W2d T10 fix round 1 I2: where the division's rulebook pays an outcome apart (IIHF's overtime, FIVB's 3-2, ITTF's loss
      // not played), the FLAT rule is refused by name and nothing is stored; a rule that states a split (a loss not played
      // paying 0) is the caller's own and is saved. Cricket's tie and no result are a flat rule's own fields, never a split.
      const splits = (RULEBOOK_SPLITS[`${key}/${rig.variant}`] ?? []).filter((r) => r !== "tie" && r !== "noResult");
      const stated = (r: typeof BASE_POINTS) => (splits.length === 0 ? r : { ...r, loss: { ...r.loss, unplayed: 0 } });
      const base = stated(BASE_POINTS);
      const second = stated(SECOND_POINTS);
      if (want.ok) {
        if (splits.length > 0) {
          await expect(putStageRules(b.auth, b.stageId, { points: BASE_POINTS }), `${key}/${rig.variant}: the flat rule`).rejects.toMatchObject({
            status: RULE_ERROR_STATUS.POINTS_SPLIT_FLATTENED,
            code: "POINTS_SPLIT_FLATTENED",
            extra: { splits },
          });
          expect(Object.hasOwn(await stageConfig(b.stageId), "points"), "refused flat: no points stored").toBe(false);
          seen.pointsRefusedFlat.add(key);
        }
        const stored = PointsRule.parse(base);
        const out = await putStageRules(b.auth, b.stageId, { points: base });
        expect(canonicalJson(out.points), "the rule as the engine reads it (defaults in)").toBe(canonicalJson(stored));
        expect(canonicalJson(out.rules), "the rules arm, omitted, is left as stored").toBe(canonicalJson(rulesStage));
        const replaced = await putStageRules(b.auth, b.stageId, { points: second });
        expect(canonicalJson(replaced.points), "second call: a rule is one sentence, written whole").toBe(canonicalJson(PointsRule.parse(second)));
        const cfg = await stageConfig(b.stageId);
        expect(canonicalJson(cfg.points), "stored at stages.config.points").toBe(canonicalJson(PointsRule.parse(second)));
        expect(canonicalJson(rulesOf(cfg)), "points saved, rules untouched").toBe(canonicalJson(rulesStage));
        seen.pointsSaved.add(key);
      } else {
        // The stage can end in an outcome the rule does not pay (cricket's tie): refused by name, nothing stored.
        expect(want.inapplicable, "premise: an outcome, not a set-score table on a sport with none").toEqual([]);
        await expect(putStageRules(b.auth, b.stageId, { points: BASE_POINTS })).rejects.toMatchObject({
          status: RULE_ERROR_STATUS.POINTS_OUTCOME_UNCOVERED,
          code: "POINTS_OUTCOME_UNCOVERED",
          extra: { uncovered: want.uncovered },
        });
        const cfg = await stageConfig(b.stageId);
        expect(Object.hasOwn(cfg, "points"), "refused: no points stored").toBe(false);
        expect(canonicalJson(rulesOf(cfg)), "refused points leave the rules arm alone").toBe(canonicalJson(rulesStage));
        seen.pointsRefusedUncovered.add(key);
      }

      // ---- 3. one match's own override (T19) -----------------------------------------------------------------------
      const stageResolved = resolved(m, rig, rig.stageKey.frag);
      const versionBeforeMatch = (await fixtureRow(fixA)).rules_version;
      let matchEffective: Record<string, unknown> = stageResolved;
      if (rig.matchKey !== null) {
        const mk = rig.matchKey;
        const out = await writeFixtureRulesOverride(b.auth, [fixA], mk.frag);
        expect(out.fixtures, "the writer names the one match it wrote, unstarted, one version on").toEqual([
          { id: fixA, started: false, rules_version: versionBeforeMatch + 1 },
        ]);
        const row = await fixtureRow(fixA);
        expect(Object.keys(row.rules_override ?? {}), "stored at fixtures.rules_override: the one key sent").toEqual([mk.key]);
        matchEffective = resolved(m, rig, rig.stageKey.frag, mk.frag);
        const block = await loadFixtureMatchRules(b.auth, fixA, dict);
        expect(block.state, "the match block: this match is unstarted").toBe("unstarted");
        expect(block.override, "the block shows the stored override").toEqual(row.rules_override);
        expect(same(block.stageResolved[rig.stageKey.key], stageResolved[rig.stageKey.key]), "the block's stage line has the stage's own value").toBe(true);
        expect(same(block.stageResolved[mk.key], stageResolved[mk.key]), "the match's change did not leak into the stage").toBe(true);
        expect(same(block.effective[mk.key], matchEffective[mk.key]), "the match plays the override").toBe(true);
        expect(same(block.effective[rig.stageKey.key], matchEffective[rig.stageKey.key]), "and the stage's rules under it").toBe(true);
        const pad = await loadFixturePadCfg(b.auth, fixA);
        expect(same((pad.cfg as Record<string, unknown>)[mk.key], matchEffective[mk.key]), "the open pad folds the same format as the block").toBe(true);
        expect(pad.rulesVersion, "and appends against the version the writer returned").toBe(versionBeforeMatch + 1);
        // the second call: nothing moves, nothing bumps
        const resend = await writeFixtureRulesOverride(b.auth, [fixA], mk.frag);
        expect(resend.fixtures[0]!.rules_version, "second call: the same version").toBe(versionBeforeMatch + 1);
        expect(canonicalJson((await fixtureRow(fixA)).rules_override), "second call: the same stored override").toBe(canonicalJson(row.rules_override));
        const sibling = await loadFixtureMatchRules(b.auth, fixB, dict);
        expect(sibling.override, "another match of the stage is untouched").toBeNull();
        expect(same(sibling.effective[mk.key], stageResolved[mk.key]), "and plays the stage's value").toBe(true);
        seen.matchSaved.add(key);
      } else {
        // The sport declares no match-scoped key (X-SR-2): the per-match door refuses a stage-only key by declaration.
        expect(rig.matchTops, "premise: the engine declares no match-scoped key for a league stage").toEqual([]);
        await expect(writeFixtureRulesOverride(b.auth, [fixA], rig.inheritedKey.frag)).rejects.toMatchObject({
          status: RULE_ERROR_STATUS.RULE_NOT_SETTABLE,
          code: "RULE_NOT_SETTABLE",
          extra: { fixture_id: fixA },
        });
        const row = await fixtureRow(fixA);
        expect(row.rules_override, "refused: nothing stored").toBeNull();
        expect(row.rules_version, "refused: no new version").toBe(versionBeforeMatch);
        seen.matchRefusedByDeclaration.add(key);
      }
      const rowA = await fixtureRow(fixA);

      // ---- 4. the stage starts: a real score event on another match -------------------------------------------------
      const stageBefore = canonicalJson(await stageConfig(b.stageId));
      const started = await appendEvent(b.auth.orgId, fixB, 0, START);
      expect(await formatLockedStageIds(b.auth, b.divisionId), "the stage editor's read: the stage is locked").toEqual([b.stageId]);
      const refusedLock = { status: RULE_ERROR_STATUS.STAGE_FORMAT_LOCKED, code: "STAGE_FORMAT_LOCKED", extra: { stage_name: stageName } };
      await expect(putStageRules(b.auth, b.stageId, { rules: rig.stageKey.frag }), "even a re-send is a write the lock refuses").rejects.toMatchObject(refusedLock);
      await expect(putStageRules(b.auth, b.stageId, { rules: rig.inheritedKey.frag })).rejects.toMatchObject(refusedLock);
      await expect(putStageRules(b.auth, b.stageId, { rules: null })).rejects.toMatchObject(refusedLock);
      await expect(putStageRules(b.auth, b.stageId, { points: second })).rejects.toMatchObject(refusedLock);
      await expect(putStageRules(b.auth, b.stageId, { points: null }), "a removal is a change too").rejects.toMatchObject(refusedLock);
      expect(canonicalJson(await stageConfig(b.stageId)), "every refusal wrote nothing").toBe(stageBefore);
      const blockB = await loadFixtureMatchRules(b.auth, fixB, dict);
      expect(blockB.state, "the started match is live in the block").toBe("live");
      expect((await fixtureRow(fixB)).config_snapshot, "and froze its format").not.toBeNull();
      expect(same(blockB.effective[rig.stageKey.key], stageResolved[rig.stageKey.key]), "the frozen format carries the stage's rules").toBe(true);
      const blockA = await loadFixtureMatchRules(b.auth, fixA, dict);
      expect(blockA.state, "an unstarted match of the started stage stays unstarted").toBe("unstarted");
      expect(blockA.override, "and keeps its override").toEqual(rowA.rules_override);
      if (rig.matchKey !== null) {
        // The stage's lock is the STAGE's: one unstarted match may still be re-formatted, and the writer re-versions it.
        const back = await writeFixtureRulesOverride(b.auth, [fixA], null);
        expect(back.fixtures[0]!.rules_version, "clearing an unstarted match's override in a started stage re-versions it").toBe(rowA.rules_version + 1);
        expect((await fixtureRow(fixA)).rules_override, "stored: cleared").toBeNull();
        await writeFixtureRulesOverride(b.auth, [fixA], rig.matchKey.frag);
      }
      const rowAStarted = await fixtureRow(fixA);
      const snapshotB = canonicalJson((await fixtureRow(fixB)).config_snapshot);

      // ---- 5. the division edit (T20) ------------------------------------------------------------------------------
      const locked = await divisionLockedFields(b.auth, b.divisionId);
      const lockedKeys = locked.map((r) => r.field);
      const named = (field: string, code: string) =>
        expect(entryFor(locked, field), `${field}: ${code} names the stage`).toEqual({ field, code, stageId: b.stageId, stageName });
      // X-SR-4: a started stage that INHERITS a key locks it; one that sets the key itself does not.
      named(rig.inheritedKey.key, "DIVISION_FORMAT_LOCKED");
      expect(lockedKeys, `${rig.stageKey.key} is the stage's own, so the division may change it`).not.toContain(rig.stageKey.key);
      named("variant_key", "DIVISION_FORMAT_LOCKED");
      expect(lockedKeys, "W2d T10: the division's tiebreakers are never locked (the save below lands)").not.toContain("tiebreakers");
      // X-PT-1 / W2d T10: the stage's PIN (and its own points) replace the division's win/draw/loss (`points`) and set-score
      // map (`pointsMap`) for its table; every other points-scope key the sport declares (a forfeit's award score, a board
      // game's scoring) stays locked.
      const tableKeys = [...pointsKeysFor(m, null, rig.variant), ...(Object.hasOwn(m.ruleKeys ?? {}, "pointsMap") ? ["pointsMap"] : [])];
      expect(tableKeys.length, "premise: every sport declares a points-scope key").toBeGreaterThan(0);
      for (const t of new Set(tableKeys)) {
        if (t === "points" || t === "pointsMap") {
          expect(lockedKeys, `${t}: the stage's pin replaces it, so it is free`).not.toContain(t);
        } else {
          named(t, "DIVISION_TABLE_RULES_LOCKED");
        }
      }
      // `pointsMap` is named by the table-rule set itself (rule-locks.ts `tableRuleKeys`), declared or not.
      const declared = new Set([...Object.keys(m.ruleKeys ?? {}).map(topOf), "pointsMap", "variant_key"]);
      for (const f of lockedKeys) expect(declared.has(f), `${f}: the form locks only what the engine declares`).toBe(true);
      expect(stageKeysFor(m, "league", rig.variant).map(topOf), "premise: the inherited key is one the stage kind may set").toContain(rig.inheritedKey.key);

      // the save: the inherited key is refused (the same entry the form listed), the stage's own key and the name save
      const divCfg0 = await divisionConfig(b);
      const patch = {
        name: "Renamed",
        config: { ...divCfg0, ...rig.inheritedKey.frag, ...rig.stageKey.frag },
      };
      const edit = await patchDivision(b.auth, b.divisionId, patch);
      expect(edit.name, "another setting still saves").toBe("Renamed");
      expect(edit.refused, "refused: exactly the inherited key, as the form listed it").toEqual([entryFor(locked, rig.inheritedKey.key)]);
      const divCfg1 = await divisionConfig(b);
      expect(same(divCfg1[rig.inheritedKey.key], divCfg0[rig.inheritedKey.key]), "stored: the refused key was not written").toBe(true);
      expect(same(divCfg1[rig.stageKey.key], rig.stageKey.frag[rig.stageKey.key]), "stored: the stage's own key saved at the division").toBe(true);
      // the second call: the same save is refused the same way and moves nothing
      const edit2 = await patchDivision(b.auth, b.divisionId, patch);
      expect(edit2.refused, "second call: the same refusal").toEqual(edit.refused);
      expect(canonicalJson(await divisionConfig(b)), "second call: nothing moved").toBe(canonicalJson(divCfg1));
      // W2d T10 (spec §5.4): the division's tiebreakers are never refused. The sport's own default (every default passes
      // the validator, Task 11) is the order the pinned stage already plays, so the save lands and keeps nothing.
      const order = m.defaultTiebreakers("league", m.configSchema.parse(divCfg1));
      const tbBeside = await patchDivision(b.auth, b.divisionId, { name: "Renamed again", tiebreakers: [...order] });
      expect(tbBeside.refused, "the order is not refused").toEqual([]);
      expect(tbBeside.name, "and the rename lands").toBe("Renamed again");
      expect((await getDivision(b.auth, b.divisionId)).tiebreakers, "the order is stored").toEqual(order);
      expect(tbBeside.stagesKeptPinned, "the stage already plays that order: nothing kept").toEqual([]);
      // nothing the refused and the landed keys did reached the stage, the open match, or the started match
      expect(canonicalJson(await stageConfig(b.stageId)), "the stage's stored config is untouched by the division edit").toBe(stageBefore);
      const rowAAfter = await fixtureRow(fixA);
      expect(rowAAfter.rules_version, "the unstarted match's version did not move: it resolves to the same format").toBe(rowAStarted.rules_version);
      expect(canonicalJson(rowAAfter.rules_override), "nor its override").toBe(canonicalJson(rowAStarted.rules_override));
      expect(canonicalJson((await fixtureRow(fixB)).config_snapshot), "the started match's frozen format did not move").toBe(snapshotB);
      // the stage's pin frees the division's win/draw/loss (or set-score map); the control below locks the same edit
      const moved = movedTablePatch(m, divCfg1);
      if (moved !== null) {
        const padBefore = (await loadFixturePadCfg(b.auth, fixA)).cfg;
        const pt = await patchDivision(b.auth, b.divisionId, { config: { ...divCfg1, [moved.key]: moved.value } });
        expect(pt.refused, `${moved.key}: replaced by the stage's pin, so it saves`).toEqual([]);
        // `stagesKeptPinned` names a pinned stage whose LIVE layers the save moved (what it would read were it pending): a
        // stage with its own points (step 2) never read the division's, so nothing was kept from it (spec §5.4 "so nothing
        // is dropped silently").
        const ownsPoints = Object.hasOwn(await stageConfig(b.stageId), "points");
        expect(ownsPoints, "premise: the stage owns points exactly when step 2 saved them").toBe(seen.pointsSaved.has(key));
        expect(pt.stagesKeptPinned.map((x) => x.stageId), `${moved.key}: the pinned stage it did not reach is named (own points: none)`).toEqual(ownsPoints ? [] : [b.stageId]);
        if (!ownsPoints) seen.keptNamed.add(key);
        expect(same((await divisionConfig(b))[moved.key], moved.value), `stored: ${moved.key} saved`).toBe(true);
        // X-SR-7: the unstarted match's version moves exactly when the format the pad folds does. The division's table key is
        // part of that cfg, so the pad is told to reload even though the stage's own points make the key inert for its table.
        const padAfter = (await loadFixturePadCfg(b.auth, fixA)).cfg;
        const bump = same(padBefore, padAfter) ? 0 : 1;
        expect((await fixtureRow(fixA)).rules_version, "the version follows the folded format").toBe(rowAStarted.rules_version + bump);
        seen.tableSaveWitnessed.add(key);
      }
      const blockAfter = await loadFixtureMatchRules(b.auth, fixA, dict);
      expect(same(blockAfter.stageResolved[rig.stageKey.key], stageResolved[rig.stageKey.key]), "the stage still plays its own value").toBe(true);
      expect(same(blockAfter.stageResolved[rig.inheritedKey.key], stageResolved[rig.inheritedKey.key]), "and the division's inherited one").toBe(true);

      // ---- X-SR-3: a void does not unlock ---------------------------------------------------------------------------
      const voided = await appendEvent(b.auth.orgId, fixB, 1, { type: "core.void", payload: {}, voids: started.event.id });
      expect(voided.event.voids, "the void landed").toBe(started.event.id);
      expect(await formatLockedStageIds(b.auth, b.divisionId), "after the void the stage is still locked").toEqual([b.stageId]);
      await expect(putStageRules(b.auth, b.stageId, { rules: rig.stageKey.frag })).rejects.toMatchObject(refusedLock);
      expect(await divisionLockedFields(b.auth, b.divisionId), "and the division form still lists the same locks").toEqual(locked);
      seen.voidKeptLock.add(key);

      // ---- the control: the same sport started with NO pin and no stage points locks the table keys this one freed --------
      // (W2d T10: a pre-W2d row — ACTIVE, no pin: the post-deploy pin's input, which no product path writes, so it is shaped by
      // hand — the only stage the W2c points lock still holds. A stage that starts PENDING with no pin, an ad-hoc match, is
      // pinned by the save instead: division-locks.test.ts "W2d T10 fix round 1 (I1)".)
      const freed = [...new Set(tableKeys)].filter((t) => t === "points" || t === "pointsMap");
      if (freed.length > 0) seen.controlOwed.add(key);
      if (freed.length > 0) {
        const c = await seedBracket({ sport: key, variant: rig.variant, stageKind: "league", entrants: 3 });
        await appendEvent(c.auth.orgId, c.fixtureIds[0]!, 0, START);
        await sql`update stages set table_rules_pinned = null, table_rules_pinned_at = null where id = ${c.stageId}`;
        const cl = await divisionLockedFields(c.auth, c.divisionId);
        for (const t of freed) {
          expect(entryFor(cl, t), `${t}: with no pin and no stage points the started stage inherits the division's`).toEqual({
            field: t,
            code: "DIVISION_TABLE_RULES_LOCKED",
            stageId: c.stageId,
            stageName,
          });
        }
        if (moved !== null) {
          const cd = (await getDivision(c.auth, c.divisionId)).config as Record<string, unknown>;
          const cm = movedTablePatch(m, cd);
          expect(cm, "the control moves the same table key").not.toBeNull();
          await expect(patchDivision(c.auth, c.divisionId, { config: { ...cd, [cm!.key]: cm!.value } }), `${cm!.key}: the same edit is refused without a pin`).rejects.toMatchObject({
            status: RULE_ERROR_STATUS.DIVISION_TABLE_RULES_LOCKED,
            code: "DIVISION_TABLE_RULES_LOCKED",
            extra: { refused: [entryFor(cl, cm!.key)] },
          });
        }
        seen.controlLocked.add(key);
      }
      seen.sports.add(key);
    }, 240_000);
  }

  it("anti-vacuity: every sport ran the whole sequence, and every branch was witnessed", () => {
    const all = sportCases().map((c) => c.key);
    expect(all.length, "the registry is not empty").toBeGreaterThan(0);
    expect([...seen.sports].sort(), "every registry sport completed the sequence").toEqual([...all].sort());
    expect(seen.voidKeptLock.size, "the void kept the lock for every sport").toBe(all.length);
    expect(seen.matchSaved.size + seen.matchRefusedByDeclaration.size, "every sport took one of the two match branches").toBe(all.length);
    expect(seen.matchSaved.size, "some sport saved a match override").toBeGreaterThan(0);
    expect(seen.matchRefusedByDeclaration.size, "some sport declares no match key and was refused by declaration").toBeGreaterThan(0);
    expect(seen.pointsSaved.size + seen.pointsRefusedUncovered.size, "every sport took one of the two points branches").toBe(all.length);
    expect(seen.pointsSaved.size, "some sport saved stage points").toBeGreaterThan(0);
    expect(seen.pointsRefusedUncovered.size, "some sport's stage can end in an outcome the points do not pay (cricket's tie)").toBeGreaterThan(0);
    expect(seen.pointsRefusedFlat.size, "fix round 1 I2: some sport's rulebook split refused the flat rule").toBeGreaterThan(0);
    expect([...seen.pointsRefusedFlat].filter((k) => !seen.pointsSaved.has(k)), "and each then saved the rule that states a split").toEqual([]);
    expect([...seen.controlLocked].sort(), "the control ran for every sport whose stage points free a table key").toEqual([...seen.controlOwed].sort());
    expect(seen.controlLocked.size, "the control ran for at least one sport").toBeGreaterThan(0);
    expect(seen.tableSaveWitnessed.size, "the table-key edit saved for at least one sport").toBeGreaterThan(0);
    expect(seen.keptNamed.size, "W2d T10: some sport's pinned stage (no own points) was named in stagesKeptPinned").toBeGreaterThan(0);
  });
});
