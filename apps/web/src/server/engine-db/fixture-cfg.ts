import "server-only";
import { PointsRule, forfeitAwardOffer } from "@seazn/engine/competition";
import type { ForfeitAward } from "@seazn/engine/core";
import type { AnySportModule } from "@seazn/engine/sport";
import { liveStageCfg, type DeciderOffSource } from "@/lib/stage-decider-off";

/** The fixture's stage, as every caller already reads it: its kind (the overlay's switch) and its config (the
 *  stage-scoped overlay `stageScopedCfg` applies). Null/undefined = no stage row (a fixture outside any stage). */
export interface FixtureStageSource {
  readonly kind: string | null | undefined;
  readonly config: Record<string, unknown> | null | undefined;
}
/** The members of a sport module the bracket overlay needs (and, through `ruleKeys`, the stage overlay's "off" for a
 *  decider whose engine off is null: `lib/stage-decider-off.ts`); every SportModule satisfies it. */
export interface DeciderSource extends DeciderOffSource {
  readonly configSchema: { safeParse(v: unknown): { success: boolean; data?: unknown } };
  bracketDeciders(cfg: never): Record<string, unknown>;
}
/**
 * W2c D4 (spec §4.4) — the fixture ROW, as every caller reads it: the frozen cfg AND the match's own override. Both
 * keys are required so the compiler sends every caller back to its SELECT for `rules_override`; tsc cannot read
 * the SQL text itself, which is why `bracket-overlay-callers.test.ts` drives each one with an override seeded.
 *
 * `rules_override` is `fixtures.rules_override` (V462): match-scoped keys only, written by the one validated writer
 * (Task 14). Null = the fixture plays its stage's rules. `undefined` reads the same way, exactly as an unselected
 * `config_snapshot` does — a column that was not selected is not an override.
 */
export interface FixtureCfgSource {
  readonly config_snapshot: unknown;
  readonly rules_override: unknown;
}

/**
 * WHICH CONFIG DOES THIS FIXTURE FOLD AGAINST — the one decision, in one place.
 *
 * WHY THIS FILE EXISTS. `cfg` used to be rebuilt LIVE from
 * `stageScopedCfg(division.config, stage?.config)` at every call site, and every
 * READ replays the fixture's whole ledger from `init` (there is no incremental
 * fold and no cached partial state). So editing a division's config changed the
 * input to every past fold at once: a finished fixture silently rescored, and —
 * worse — any cfg-derived refusal inside a fold started firing on events ALREADY
 * IN THE LEDGER. Those events were each legal when recorded, so there is no
 * event to void and no scorer action that recovers it; the state endpoint, the
 * score page and standings all throw and the fixture is permanently unviewable.
 * Six instances of that exact shape were found by hand in W4a alone.
 *
 * V347 freezes the resolved cfg onto `fixtures.config_snapshot` when the first
 * event is appended. This resolver is the ONLY reader of that column: both the
 * write fold (`append-event.ts`) and the read fold (`fold.ts`) go through it, so
 * no surface can drift back to live config on its own — and the two stay
 * byte-consistent, which `verifyStateConsistency` depends on (a read that
 * disagreed with the write would read as phantom state drift).
 *
 * A fixture with ZERO events reads LIVE config, deliberately and not by
 * accident: `config_snapshot is null` is precisely "not scored yet", and an
 * organiser still setting the division up must have the format they choose
 * apply. The snapshot begins the moment there is history worth protecting.
 *
 * The snapshot is the RESOLVED cfg — `stageScopedCfg`'s OUTPUT, stage overlay
 * already applied. Freezing the raw division config instead would leave the
 * overlay to be re-applied at read time against a stage config that has since
 * moved, which is the same drift one layer down.
 *
 * W2a (ruling 76, spec §5.4.1): a fixture in a BRACKET stage kind
 * (`forbidsLevelResult`) also gets the sport's `bracketDeciders(cfg)` on top of
 * the stage-scoped cfg — chess's tie-break, carrom's extra board — and the
 * overlay wins over the division and the stage (CA-KO-1: a bracket always plays
 * the extra board, whatever the division's `tieBoard`). The V347 freeze then
 * carries it from the first event; a frozen snapshot is returned untouched
 * (Review Focus 4: a fixture scored before deploy keeps its cfg and finishes
 * through needs_decision and settle).
 *
 * The sport's schema is asked with `safeParse`, never `parse`: this output goes
 * to `foldMatch` UNPARSED and every module tolerates a cfg its schema rejects
 * (`match-centre-load.ts`'s safeParse note), so a throwing parse would make the
 * read path of a bracket fixture stricter than the fold itself — a 500 on a
 * config that scores fine. On a refusal the raw cfg is passed; no shipped
 * `bracketDeciders` reads a cfg field.
 *
 * W2c (spec §4.4, P3): the fixture's own match override (`rules_override`)
 * lands LAST — after the division, the stage's rules and the bracket deciders —
 * so one match can switch a decider off or shorten its format (X-SR-2), and a
 * later stage edit still moves every key the match did not override (Review
 * Focus 2). Order: `snapshot ?? (division ⊕ stage.rules ⊕ bracketDeciders(kind)
 * ⊕ rules_override)`, the last `⊕` a leaf merge in which null means inherit
 * (`mergeRulesOverride`, below). The snapshot still wins outright: at the first event the
 * override is frozen into it with everything else, and only the Q11 correction
 * (Task 14) re-freezes a started match. A cfg that is not an object (the JSON
 * null division carve-out above) takes no override either: rebuilding it from
 * the override's keys alone would hand the fold, and the freeze, a cfg holding
 * nothing else.
 *
 * @param fixture the fixture row (`FixtureCfgSource`): `config_snapshot` as the
 *   driver returns it — the frozen jsonb, or null/undefined when none has been
 *   taken; presence is the test, not truthiness, since `{}` is a legitimate
 *   config for several modules — and `rules_override`.
 * @param stage the fixture's stage row (`kind` and `config`); every caller
 *   selects `s.kind` beside the `config` it already read.
 * @param module the fixture's sport module (its `bracketDeciders`).
 */
export function resolveFixtureCfg(
  fixture: FixtureCfgSource,
  divisionCfg: unknown,
  stage: FixtureStageSource | null | undefined,
  module: DeciderSource,
): unknown {
  if (hasFrozenCfg(fixture.config_snapshot)) return fixture.config_snapshot;
  const decided = liveCfg(divisionCfg, stage, module);
  if (!isCfgObject(decided)) return decided;
  return mergeRulesOverride(decided, fixture.rules_override);
}

const isCfgObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** A key written as an own data property, whatever its name (`__proto__` included): never through a setter. */
function put(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** One override value over the cfg's own. An object whose every key the cfg's object also has is a CHANGE to that
 *  object, merged leaf by leaf, so a stage edit to a leaf the match did not touch still reaches it (carry (c)). An
 *  object naming a key the cfg's lacks is a different SHAPE — tennis's `finalSet` switching from `{tiebreakTo}` to
 *  `{matchTiebreakTo}` (a union of strict objects) — and replaces it whole; so does anything that is not an object on
 *  both sides. Never mutates either input. */
function mergeValue(base: unknown, ov: unknown): unknown {
  if (!isCfgObject(base) || !isCfgObject(ov)) return ov;
  if (!Object.keys(ov).every((k) => Object.hasOwn(base, k))) return ov;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(ov)) put(out, k, mergeValue(base[k], v));
  return out;
}

/**
 * W2c (Task 14) — a match's own format over the cfg its stage resolves: `rules_override` holds only the LEAVES the
 * match changed (the one writer, `usecases/fixture-rules.ts`, stores a diff), merged per `mergeValue`.
 *
 * NULL = INHERIT (Task 10 M2), as in a stage's `rules` (`stageScopedCfg`): a top-level key whose value is null or
 * undefined is skipped, never copied — a copied null would BLANK the stage's value. The writer never stores one; this
 * is the second half of that contract. A consequence: a match cannot set a nullable top-level key (badminton's `cap`)
 * to null on its own.
 */
export function mergeRulesOverride(decided: Record<string, unknown>, ov: unknown): Record<string, unknown> {
  if (!isCfgObject(ov)) return decided;
  const out: Record<string, unknown> = { ...decided };
  for (const [k, v] of Object.entries(ov)) {
    if (v === null || v === undefined) continue;
    put(out, k, mergeValue(decided[k], v));
  }
  return out;
}

/** `division ⊕ stage.rules ⊕ bracketDeciders(kind)`: the cfg a fixture with no snapshot and no override folds — its
 *  STAGE's format. Exported for the one override writer (`usecases/fixture-rules.ts`), which validates a match's own
 *  format against it and builds the corrected cfg as `mergeRulesOverride(liveCfg(…), override)`, exactly the last
 *  step below. It reads no fixture row, so it is not a `resolveFixtureCfg` site. */
export function liveCfg(divisionCfg: unknown, stage: FixtureStageSource | null | undefined, module: DeciderSource): unknown {
  // The composition is lib/stage-decider-off.ts `liveStageCfg` (fix round 2, review M-3): the format-matrix harness folds
  // under the same code, never a copy.
  return liveStageCfg(divisionCfg, stage, module);
}

/**
 * "Does this fixture have a frozen config?" — ONE predicate, for the resolver
 * above, the freeze in `append-event.ts` and the `/admin` panel alike.
 *
 * They used to answer it three times: the freeze tested `=== null`, the resolver
 * treated `undefined` as absent too, and the panel tested `!== null` again. They
 * agree only as long as every query selects the column; add one that does not
 * and the freeze would re-take a snapshot the resolver was already honouring,
 * under whatever config happens to be live by then.
 *
 * `undefined` is absence for the same reason `null` is — a column that was not
 * selected is not a config — and both are distinct from `{}`, `0` and `""`,
 * which are legitimate frozen configs.
 */
export function hasFrozenCfg(snapshot: unknown): boolean {
  return snapshot !== null && snapshot !== undefined;
}

/**
 * W2c Task 16b (X-WO-1 part B; Task 9 P-3 "A") - the walkover score the fixture's STAGE offers a fold: its points rule's
 * `forfeit.awardScore` (winner first), and only where that award reaches the sport's table (`forfeitAwardOffer`, the
 * engine's one place). `undefined` for a stage with no points rule, a rule with no award, a sport the award never reaches,
 * and a stored rule `PointsRule` will not read (asked with `safeParse`, never `parse`: this feeds a fold, which must not be
 * made stricter than the table's own read of the same rule).
 *
 * It is NOT part of the cfg (`resolveFixtureCfg`): the cfg is frozen into `config_snapshot` at the first event and the
 * award replaces the sport's credit only for a forfeit with NOTHING PLAYED, a fact the ledger knows and a cfg cannot (an
 * unconditional overlay would move the credit of a forfeit after play too). It travels beside the cfg as its own fold
 * input (`FoldOptions.forfeitAward`), and the kernel decides per forfeit whether it applies. Every production fold of a
 * fixture's ledger offers it (pinned in `__tests__/forfeit-award-callers.test.ts`).
 *
 * It needs no snapshot: the stage's rule cannot change once any match of the stage has an event or a frozen cfg
 * (`putStageRules` refuses STAGE_FORMAT_LOCKED), so the value read at the first event is the value for the stage's life.
 */
export function stageForfeitAward(
  stage: FixtureStageSource | null | undefined,
  module: Pick<AnySportModule, "awardScoreKeys">,
): ForfeitAward | undefined {
  const raw = stage?.config?.points;
  if (raw === undefined || raw === null) return undefined;
  const rule = PointsRule.safeParse(raw);
  return rule.success ? forfeitAwardOffer(rule.data, module) : undefined;
}
