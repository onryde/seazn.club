import "server-only";
// server/usecases/capture-stage.ts — W28 (capture QR v2 §6.4, owner sign-off 2026-10-06): the descriptor's optional
// `stage`, on the waiting shape and every session state. Where the match sits in its stage, named exactly as the
// scheduler board names it, recomputed on every read from ONE statement (nothing is stored).
//
//  - `code`: the board's chip — `boardRoundCodes` over the stage's fixtures, else `R{round_no}` (fixture-block.tsx's own
//    fallback) — rendered in the org's default_locale, like the descriptor's label (W25): an `es` org reads CF.
//  - `role`: the engine's `RoundRole` for the fixture (`roundRoleFor`, the board's own call), serialised verbatim.
//  - `pool`: the fixture's pool KEY (`pools.key`, one capital letter), never its English name.
//  - `label` (owner ruling 2026-10-08, Option A): what the phone shows verbatim — the division's name, the pool's display
//    label (`poolLabel`, `table.poolLabel` of the org locale's `public` dictionary: "Group A", "Grupo A", "Poule A") and
//    the round's text, joined with " · ", a part that is absent left out: "Open · Round 2", "Open · QF",
//    "Girls U14 · Group A · Round 2". The round's text is `code` for every coded round, and the long
//    `bracket.round.plain` ("Round {n}", "Ronda {n}") for an uncoded one — a plain round — with the n its `R{n}` chip
//    shows. Over 40 characters the pool word is dropped, then the division; still over, the label is omitted, the rest
//    of the stage kept. Each drop is logged.
//
// ONE builder, `buildCaptureStage`, returns `{code, role, pool?, label?}`.
import type { RoundRole } from "@seazn/engine/competition";
import { sql } from "@/lib/db";
import { getDictionary, toLocale } from "@/lib/i18n";
import type { MessageKey } from "@/lib/messages";
import { msgFor } from "@/lib/messages-i18n";
import { poolLabel } from "@/lib/pool-label";
import { laneRoundRank, roundRoleFor } from "@/lib/round-role-label";
import { boardRoundCodes, type RoundCodeFixture } from "@/components/v2/board/round-codes";
import { CAPTURE_POOL_RE, CAPTURE_STAGE_LABEL_MAX, CaptureStage } from "@/server/api-v1/capture-schemas";
import { log } from "@/server/logger";

type Msg = (key: MessageKey, vars?: Record<string, string | number>) => string;
/** A pool's display label from its key, in the org's locale (`poolLabel` over the `public` dictionary). */
type PoolText = (key: string) => string;

export type CaptureStageInput = {
  fixtureId: string;
  /** `stages.kind` of the fixture's stage. */
  stageKind: string;
  /** `pools.key` of the fixture's pool; null when it has none. */
  poolKey: string | null;
  /** `divisions.name` of the fixture's division; null or blank leaves the division out of the label. */
  divisionName: string | null;
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
 *  - anything else the contract refuses (a code outside 1–8 characters) omits the whole stage, logged;
 *  - a `label` over 40 characters is never cut — the phone shows it verbatim, and nothing when it is missing: the pool
 *    word is dropped first, then the division (owner ruling 2026-10-08), and a round's text still over 40 omits the
 *    label, the rest of the stage kept. Each step is logged with the part it dropped, never the words. `poolText` is
 *    asked only when there IS a pool.
 */
export function buildCaptureStage(input: CaptureStageInput, msg: Msg, poolText: PoolText): CaptureStage | null {
  const { fixtureId, stageKind, poolKey, divisionName, rows } = input;
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
  const code = rc?.code ?? `R${self.round_no}`;
  // The round's text. An uncoded round is exactly a plain round — the role is forced to `plain_round` above whenever
  // the board leaves the chip uncoded, and the board codes no plain round (`roundRoleShort`) — so it reads the long form
  // with the n its chip `R{round_no}` shows; every coded round reads its chip.
  const round = rc === undefined ? msg("bracket.round.plain", { n: self.round_no }) : rc.code;
  const division = divisionName?.trim() || undefined;
  const label = fitLabel(fixtureId, { division, pool: pool !== undefined ? poolText(pool) : undefined, round });
  const stage = { code, role: { ...role }, ...(pool !== undefined ? { pool } : {}), ...(label !== undefined ? { label } : {}) };
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

/** The label's parts, in the order the phone reads them; an undefined part is left out. */
type LabelParts = { division: string | undefined; pool: string | undefined; round: string };
const joinLabel = ({ division, pool, round }: LabelParts): string =>
  [division, pool, round].filter((p) => p !== undefined).join(" · ");

/**
 * The label that fits the contract's 40 (owner ruling 2026-10-08): the pool word dropped first, then the division; a
 * round's text still over 40 is no label. Each drop is logged with the length it found and the part it dropped.
 */
function fitLabel(fixtureId: string, parts: LabelParts): string | undefined {
  let label = joinLabel(parts);
  if (label.length > CAPTURE_STAGE_LABEL_MAX && parts.pool !== undefined) {
    log.warn({ fixtureId, length: label.length, dropped: "pool" }, "capture stage: the label is over 40 characters; pool dropped");
    parts = { ...parts, pool: undefined };
    label = joinLabel(parts);
  }
  if (label.length > CAPTURE_STAGE_LABEL_MAX && parts.division !== undefined) {
    log.warn({ fixtureId, length: label.length, dropped: "division" }, "capture stage: the label is over 40 characters; division dropped");
    parts = { ...parts, division: undefined };
    label = joinLabel(parts);
  }
  if (label.length > CAPTURE_STAGE_LABEL_MAX) {
    log.warn({ fixtureId, length: label.length, dropped: "label" }, "capture stage: the label is over 40 characters; label omitted");
    return undefined;
  }
  return label;
}

type StageRow = RoundCodeFixture & { kind: string; pool_key: string | null; division_name: string | null; default_locale: string | null };

/**
 * The descriptor's `stage` for `fixtureId` (W28): ONE statement — the fixture's stage's fixtures (the board's columns,
 * through `fixtures_stage_idx`), the stage's kind, the fixture's pool key, its division's name and the org's locale —
 * then the builder.
 * Non-tenant `sql`, bounded by `orgId` (the code row's org), like every read in capture-phone.ts. null = omit.
 * The pool word comes from the `public` dictionary (`getDictionary`, the public pages' own loader): `msgFor` reads the
 * `ui` catalogue alone.
 */
export async function captureStageOf(orgId: string, fixtureId: string): Promise<CaptureStage | null> {
  const rows = await sql<StageRow[]>`
    select f.id, f.stage_id, f.round_no, f.seq_in_round, f.ext_key, f.lane, f.is_final, f.third_place, f.conditional,
           s.kind, p.key as pool_key, d.name as division_name, o.default_locale
      from fixtures t
      join divisions d on d.id = t.division_id
      join organizations o on o.id = d.org_id
      join stages s on s.id = t.stage_id
      left join pools p on p.id = t.pool_id
      join fixtures f on f.stage_id = t.stage_id
     where t.id = ${fixtureId} and d.org_id = ${orgId}`;
  if (rows.length === 0) return null;   // the fixture went with its code (T35); the descriptor's own read answers that
  const { kind, pool_key, division_name, default_locale } = rows[0]!;
  const locale = toLocale(default_locale);
  const publicDict = await getDictionary(locale, "public");
  return buildCaptureStage(
    { fixtureId, stageKind: kind, poolKey: pool_key, divisionName: division_name, rows },
    (key, vars) => msgFor(locale, key, vars),
    (key) => poolLabel(publicDict, key),
  );
}
