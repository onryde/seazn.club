import "server-only";
// server/usecases/capture-stage.ts — W28 (capture QR v2 §6.4, owner sign-off 2026-10-06): the descriptor's optional
// `stage`, on the waiting shape and every session state. Where the match sits in its stage, named exactly as the
// scheduler board names it, recomputed on every read from ONE statement (nothing is stored).
//
//  - `code`: the board's chip — `boardRoundCodes` over the stage's fixtures, else `R{round_no}` (fixture-block.tsx's own
//    fallback) — rendered in the org's default_locale, like the descriptor's label (W25): an `es` org reads CF.
//  - `role`: the engine's `RoundRole` for the fixture (`roundRoleFor`, the board's own call), serialised verbatim.
//  - `pool`: the fixture's pool KEY (`pools.key`, one capital letter), never its English name.
//
// ONE builder, `buildCaptureStage`, returns `{code, role, pool?}` (controller, 2026-10-06: a later commit adds `label`
// there, and nowhere else).
import type { RoundRole } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import { toLocale } from "@/lib/i18n";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import { laneRoundRank, roundRoleFor } from "@/lib/round-role-label";
import { boardRoundCodes, type RoundCodeFixture } from "@/components/v2/board/round-codes";
import { CAPTURE_POOL_RE, CaptureStage } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;

export type CaptureStageInput = {
  fixtureId: string;
  /** `stages.kind` of the fixture's stage. */
  stageKind: string;
  /** `pools.key` of the fixture's pool; null when it has none. */
  poolKey: string | null;
  /** EVERY fixture of the fixture's stage (the board's round-code columns): a round role is a position in the stage. */
  rows: readonly RoundCodeFixture[];
};

/**
 * The stage of one fixture, or null when no stage can be produced (the descriptor then omits the field — never null).
 *
 * Build decisions (2026-10-06, recorded in the spec's §6.4 row, for review):
 *  - a bracket stage the board refuses to code (`hasRoleMetadata`: rows from before V368, or a page playoff whose
 *    rows lost their keys) reads `R{n}` on the board, and `roundRoleFor` would read its column DEFAULTS as bracket
 *    positions (a bronze match "final", a 3-lane double elimination one lane) — so it gets the plain round ordinal,
 *    `plain_round` with the round's rank + 1, the role every uncoded round has, and the role never contradicts the chip;
 *  - `pools.key` has no CHECK: a key outside `^[A-Z]$` is omitted (and logged), the rest of the stage kept;
 *  - anything else the contract refuses (a code outside 1–8 characters) omits the whole stage, logged.
 */
export function buildCaptureStage(input: CaptureStageInput, msg: Msg): CaptureStage | null {
  const { fixtureId, stageKind, poolKey, rows } = input;
  const self = rows.find((r) => r.id === fixtureId);
  // An assumption made a guard: the rows are read THROUGH the fixture's own stage, so it is always among them.
  if (self === undefined) throw new RangeError(`buildCaptureStage: fixture ${fixtureId} is not among its stage's rows`);

  const codes = boardRoundCodes(rows, [{ id: self.stage_id, kind: stageKind }], msg);
  const rc = codes.get(fixtureId);
  const laneRows = rows.map((f) => ({ round_no: f.round_no, lane: f.lane ?? null }));
  const lane = self.lane ?? null;
  const engineRole = roundRoleFor(
    laneRows,
    { round_no: self.round_no, lane, is_final: self.is_final === true, third_place: self.third_place === true, conditional: self.conditional === true },
    stageKind,
    // The board passes a page playoff's key and no other (round-codes.ts): the role must be read the same way.
    stageKind === "page_playoff" ? (self.ext_key ?? null) : null,
  );
  const role: RoundRole = rc === undefined && engineRole.kind !== "plain_round"
    ? { kind: "plain_round", n: laneRoundRank(laneRows, lane, self.round_no).roundInLane + 1 }
    : engineRole;

  let pool: string | undefined;
  if (poolKey !== null) {
    if (CAPTURE_POOL_RE.test(poolKey)) pool = poolKey;
    else log.warn({ fixtureId, poolKey }, "capture stage: the pool's key is not one capital letter; pool omitted");
  }
  const stage = { code: rc?.code ?? `R${self.round_no}`, role: { ...role }, ...(pool !== undefined ? { pool } : {}) };
  const parsed = CaptureStage.safeParse(stage);
  if (!parsed.success) {
    log.warn(
      { fixtureId, code: stage.code, issues: parsed.error.issues.map((i) => i.path.join(".")) },
      "capture stage: the stage does not fit the contract; stage omitted",
    );
    return null;
  }
  return parsed.data;
}

type StageRow = RoundCodeFixture & { kind: string; pool_key: string | null; default_locale: string | null };

/**
 * The descriptor's `stage` for `fixtureId` (W28): ONE statement — the fixture's stage's fixtures (the board's columns,
 * through `fixtures_stage_idx`), the stage's kind, the fixture's pool key and the org's locale — then the builder.
 * Non-tenant `sql`, bounded by `orgId` (the code row's org), like every read in capture-phone.ts. null = omit.
 */
export async function captureStageOf(orgId: string, fixtureId: string): Promise<CaptureStage | null> {
  const rows = await sql<StageRow[]>`
    select f.id, f.stage_id, f.round_no, f.seq_in_round, f.ext_key, f.lane, f.is_final, f.third_place, f.conditional,
           s.kind, p.key as pool_key, o.default_locale
      from fixtures t
      join divisions d on d.id = t.division_id
      join organizations o on o.id = d.org_id
      join stages s on s.id = t.stage_id
      left join pools p on p.id = t.pool_id
      join fixtures f on f.stage_id = t.stage_id
     where t.id = ${fixtureId} and d.org_id = ${orgId}`;
  if (rows.length === 0) return null;   // the fixture went with its code (T35); the descriptor's own read answers that
  const { kind, pool_key, default_locale } = rows[0]!;
  const locale = toLocale(default_locale);
  return buildCaptureStage({ fixtureId, stageKind: kind, poolKey: pool_key, rows }, (key, vars) => msgFor(locale, key, vars));
}
