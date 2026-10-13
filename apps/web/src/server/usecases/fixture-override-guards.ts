import "server-only";
import type postgres from "postgres";
import type { AnySportModule } from "@seazn/engine/sport";
import type { Tx } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { resolveFixtureCfg } from "@/server/engine-db/fixture-cfg";

// W2c Task 14 — the two guards that keep a match's own format (`fixtures.rules_override`, written only by
// `fixture-rules.ts` `writeFixtureRulesOverride`) from being lost or invalidated by a write elsewhere. Their own module,
// with no usecase import, because their callers (`stages.ts`, `history.ts`, `divisions.ts`) sit UNDER the writer's own
// imports (`scoring.ts` imports `stages.ts`): putting them beside the writer would close an import cycle.

/** The match as the board names it. */
export const matchName = (fixtureNo: number | null): string => (fixtureNo === null ? "This match" : `Match ${fixtureNo}`);

/** A SQL condition over `fixtures` (unaliased), built on the caller's transaction. */
type FixtureScope = postgres.PendingQuery<postgres.Row[]>;

/**
 * Task 10 review gap — a rebuild, an Undo of a generation and a pool clear DELETE unplayed fixtures (regenerated from
 * the stage, or restored from a snapshot that does not carry `rules_override`), so a match's own format would vanish
 * with its row and nothing would say so. Refused by name instead (`FIXTURE_HAS_OWN_FORMAT`): the organiser sets that
 * match back to its stage's format first, a visible and deliberate act. `scope` is exactly the set the caller's
 * delete removes. Deleting a whole stage is not routed here: there the organiser deletes the matches themselves.
 *
 * The code is not in `lib/rule-errors.ts`'s table: that table is the spec's seven codes (§7, pinned by
 * division-locks.test.ts), and this one is new with Task 14 — routed to the controller to adopt there.
 */
export async function refuseOwnFormatLoss(tx: Tx, scope: FixtureScope): Promise<void> {
  const [hit] = await tx<{ id: string; fixture_no: number | null }[]>`
    select id, fixture_no from fixtures where ${scope} and rules_override is not null
     order by fixture_no nulls last, id limit 1`;
  if (hit)
    throw new HttpError(
      409,
      `${matchName(hit.fixture_no)} has its own format, and this would delete it — set it back to its stage's format first.`,
      "FIXTURE_HAS_OWN_FORMAT",
      { fixture_id: hit.id },
    );
}

/**
 * batch-1 I-A, one layer up — a division save must not leave an UNSTARTED match's own format invalid:
 * `division ⊕ stage.rules ⊕ bracketDeciders ⊕ rules_override` is re-parsed for every unstarted fixture carrying one,
 * under the division config about to be written, and an invalid mix refuses the save (422 `CONFIG_INVALID`) naming
 * the match. A started match is not asked: its frozen snapshot is what it folds against (and X-SR-4 has already
 * refused every field its stage inherits).
 */
export async function refuseInvalidatedOverrides(
  tx: Tx,
  divisionId: string,
  nextDivisionConfig: unknown,
  m: AnySportModule,
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
     order by f.fixture_no nulls last, f.id`;
  for (const r of rows) {
    const cfg = resolveFixtureCfg(
      { config_snapshot: null, rules_override: r.rules_override },
      nextDivisionConfig,
      { kind: r.stage_kind, config: r.stage_config },
      m,
    );
    const parsed = m.configSchema.safeParse(cfg);
    if (parsed.success) continue;
    const first = parsed.error.issues[0];
    throw new HttpError(
      422,
      `${matchName(r.fixture_no)} has its own format, which this change would make invalid — ${first?.message ?? "the sport's rules refuse it"}. Set it back to its stage's format first.`,
      "CONFIG_INVALID",
      { fixture_id: r.id, field: typeof first?.path[0] === "string" ? first.path[0] : undefined, issues: parsed.error.issues },
    );
  }
}
