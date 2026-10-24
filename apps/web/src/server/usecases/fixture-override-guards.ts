import "server-only";
import type postgres from "postgres";
import type { StageKind } from "@seazn/engine/core";
import { checkFixtureOverride, type AnySportModule, type OverrideCheck } from "@seazn/engine/sport";
import type { Tx } from "@/lib/db";
import { configIssuesOf } from "@/lib/config-issue-copy";
import { HttpError } from "@/lib/errors";
import { RULE_ERROR_STATUS, ruleErrorMessage } from "@/lib/rule-errors";
import { LOCKED_FIXTURE_STATUSES } from "@/server/engine-db/append-event";
import { liveCfg, resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";

// W2c Task 14 — the two guards that keep a match's own format (`fixtures.rules_override`, written only by
// `fixture-rules.ts` `writeFixtureRulesOverride`) from being lost or invalidated by a write elsewhere. Their own module,
// with no usecase import, because their callers (`stages.ts`, `history.ts`, `divisions.ts`) sit UNDER the writer's own
// imports (`scoring.ts` imports `stages.ts`): putting them beside the writer would close an import cycle.

/** The match as the board names it. */
export const matchName = (fixtureNo: number | null): string => (fixtureNo === null ? "This match" : `Match ${fixtureNo}`);

/** A SQL condition over `fixtures` (unaliased), built on the caller's transaction. */
type FixtureScope = postgres.PendingQuery<postgres.Row[]>;

/** The first fixture in `scope` carrying its own format, in board order — or null. */
export async function firstOwnFormat(tx: Tx, scope: FixtureScope): Promise<{ id: string; fixture_no: number | null } | null> {
  const [hit] = await tx<{ id: string; fixture_no: number | null }[]>`
    select id, fixture_no from fixtures where ${scope} and rules_override is not null
     order by fixture_no nulls last, id limit 1`;
  return hit ?? null;
}

/** The refusal, naming the match (`FIXTURE_HAS_OWN_FORMAT`, `lib/rule-errors.ts`). */
export function ownFormatLoss(hit: { id: string; fixture_no: number | null }): HttpError {
  return new HttpError(
    RULE_ERROR_STATUS.FIXTURE_HAS_OWN_FORMAT,
    ruleErrorMessage("FIXTURE_HAS_OWN_FORMAT", { match: matchName(hit.fixture_no) }),
    "FIXTURE_HAS_OWN_FORMAT",
    // Batch-3 M1: the match's number, so a client names it in the reader's language (`ruleRefusalText`).
    { fixture_id: hit.id, fixture_no: hit.fixture_no },
  );
}

/**
 * Task 10 review gap — a rebuild, an Undo of a generation, a pool clear and a Swiss reshape (`stages.ts`
 * `reconcileSwissRoundShells`, fix round 1) DELETE unplayed fixtures (regenerated from the stage, restored from a
 * snapshot that does not carry `rules_override`, or surplus shells of a shrunk field), so a match's own format would
 * vanish with its row and nothing would say so. Refused by name instead (`FIXTURE_HAS_OWN_FORMAT`): the organiser sets
 * that match back to its stage's format first, a visible and deliberate act. `scope` is exactly the set the caller's
 * delete removes. Deleting a whole stage is not routed here: there the organiser deletes the matches themselves.
 */
export async function refuseOwnFormatLoss(tx: Tx, scope: FixtureScope): Promise<void> {
  const hit = await firstOwnFormat(tx, scope);
  if (hit) throw ownFormatLoss(hit);
}

/** The refusal for an override its stage can no longer take (`FIXTURE_OWN_FORMAT_NO_LONGER_FITS`), naming the match and
 *  the cfg path the engine's check (X-SR-2) refused. */
export function ownFormatNoLongerFits(hit: { id: string; fixture_no: number | null }, check: Extract<OverrideCheck, { ok: false }>): HttpError {
  return new HttpError(
    RULE_ERROR_STATUS.FIXTURE_OWN_FORMAT_NO_LONGER_FITS,
    ruleErrorMessage("FIXTURE_OWN_FORMAT_NO_LONGER_FITS", { match: matchName(hit.fixture_no) }),
    "FIXTURE_OWN_FORMAT_NO_LONGER_FITS",
    // The facts a client says it with (`ruleRefusalText`): the match, and the cfg path that no longer fits.
    { fixture_id: hit.id, fixture_no: hit.fixture_no, field: check.path },
  );
}

/**
 * batch-1 I-A, one layer up (and Task 14's overnight ruling) — a division or stage save must not leave an UNSTARTED
 * match's own format unable to stand. For every unstarted fixture carrying one (in the whole division, or in `stageId`'s
 * stage alone), under the division config about to stand and the stage rules as they are in the database NOW:
 *  1. `division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override` must still parse, or the save is refused (422
 *     `CONFIG_INVALID`) naming the match;
 *  2. the match may still differ from its stage in exactly the ways X-SR-2 allows (`checkFixtureOverride`, the engine's
 *     own check, against the stage's PARSED format): a decider it shortened can no longer be longer than the stage's, and
 *     a key must still be one a match may set. Otherwise the save is refused (409 `FIXTURE_OWN_FORMAT_NO_LONGER_FITS`).
 * Never a silent drop: an override that stops fitting is the organiser's to set back.
 *
 * A started match is not asked: its frozen snapshot is what it folds against (and X-SR-4 has already refused every field
 * its stage inherits). Nor is a match with an OUTCOME, or in a locked status, whatever its snapshot says (fix round 1,
 * I1): a decided match is the writer's live-correction business (`fixture-rules.ts`), a finished one's format is locked
 * — neither is "unstarted", so neither is folded against the format as it will be.
 */
export async function refuseInvalidatedOverrides(
  tx: Tx,
  divisionId: string,
  nextDivisionConfig: unknown,
  m: AnySportModule,
  variantKey: string | null,
  stageId?: string,
): Promise<void> {
  const rows = await tx<
    {
      id: string;
      fixture_no: number | null;
      rules_override: Record<string, unknown>;
      stage_kind: string | null;
      stage_config: Record<string, unknown> | null;
    }[]
  >`
    select f.id, f.fixture_no, f.rules_override, s.kind as stage_kind, s.config as stage_config
      from fixtures f left join stages s on s.id = f.stage_id
     where f.division_id = ${divisionId} and f.rules_override is not null and f.config_snapshot is null
       and f.outcome is null and f.status <> all(${[...LOCKED_FIXTURE_STATUSES]}::text[])
       ${stageId === undefined ? tx`` : tx`and f.stage_id = ${stageId}`}
     order by f.fixture_no nulls last, f.id`;
  for (const r of rows) {
    const stage = { kind: r.stage_kind, config: r.stage_config };
    const cfg = resolveFixtureCfg({ config_snapshot: null, rules_override: r.rules_override }, nextDivisionConfig, stage, m);
    const parsed = m.configSchema.safeParse(cfg);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new HttpError(
        422,
        `${matchName(r.fixture_no)} has its own format, which this change would make invalid — ${first?.message ?? "the sport's rules refuse it"}. Set it back to its stage's format first.`,
        "CONFIG_INVALID",
        // Batch-3 M2: the one wire shape for CONFIG_INVALID's issues, `{path, message}` (http.ts forwards the engine's so).
        { fixture_id: r.id, field: typeof first?.path[0] === "string" ? first.path[0] : undefined, issues: configIssuesOf(parsed.error) ?? undefined },
      );
    }
    // (2) The stage's own format, parsed - what X-SR-2 compares the match against (fixture-rules.ts step 4). A stage that
    // does not parse on its own is the stage-rules guard's business, not this match's.
    const stageParsed = m.configSchema.safeParse(liveCfg(nextDivisionConfig, stage, m));
    if (!stageParsed.success) continue;
    const corrected = parsed.data as Record<string, unknown>;
    // `rules_override` stores the LEAVES the match changed; X-SR-2 reads whole top-level values.
    const whole: Record<string, unknown> = {};
    for (const k of Object.keys(r.rules_override)) whole[k] = corrected[k];
    const check = checkFixtureOverride(m, r.stage_kind as StageKind | null, variantKey, stageParsed.data as Record<string, unknown>, whole);
    // A key the sport never declares cannot have been written by the one writer (it refuses it first), and no save of a
    // division or a stage makes a key undeclared: it is not THIS save's doing, and refusing every later save of the
    // division for it would be a lock nobody can open. Every other refusal is the save's doing, and refused.
    if (!check.ok && check.code !== "UNKNOWN_RULE_KEY") throw ownFormatNoLongerFits(r, check);
  }
}
