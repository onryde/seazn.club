// W3 T4 (RB3-15 A, ruling 252; controller ruling C2): `addFixture` now refuses a Swiss stage (SWISS_ADHOC_REFUSED), but
// rows it wrote before that still sit on live Swiss stages. The suites that used an ad-hoc Swiss board as SETUP now seed
// that legacy row directly and keep every assertion, so they pin how a LIVE legacy `adhoc-N` row behaves (open-round,
// carried-forward C7, the withdrawal reconcile and walkover). ONE helper for all of them, never a copy per suite.
//
// The row is exactly what `addFixture` (stages.ts) inserted on a Swiss stage before W3: `ext_key 'adhoc-<n+1>'` (n = the
// stage's fixture count), `round_no` = the given round or max + 1, `seq_in_round` = that round's next seq, both seats,
// `status 'scheduled'`, `scheduled_at` as given; no pool, venue or court (no caller here passed one). `org_id` and
// `fixture_no` come from the table's BEFORE INSERT triggers, as they did for `addFixture`.
import { sql } from "@/lib/db";

export async function seedLegacySwissAdhoc(
  stageId: string,
  home: string,
  away: string,
  opts: { round_no?: number; scheduled_at?: string | null } = {},
): Promise<{ fixture_id: string }> {
  const [stage] = await sql<{ division_id: string; kind: string }[]>`
    select division_id, kind from stages where id = ${stageId}`;
  // Guards, not comments: a non-Swiss stage still takes a real ad-hoc match through `addFixture`, and a seat that is
  // not the division's would seed a row `addFixture` could never have written.
  if (!stage) throw new Error(`seedLegacySwissAdhoc: no stage ${stageId}`);
  if (stage.kind !== "swiss") throw new Error(`seedLegacySwissAdhoc: stage ${stageId} is ${stage.kind}; use addFixture`);
  if (home === away) throw new Error("seedLegacySwissAdhoc: an entrant cannot play itself");
  const [{ seated }] = await sql<{ seated: number }[]>`
    select count(*)::int as seated from entrants where division_id = ${stage.division_id} and id in (${home}, ${away})`;
  if (seated !== 2) throw new Error("seedLegacySwissAdhoc: both entrants must belong to the stage's division");

  const [{ maxRound, n }] = await sql<{ maxRound: number; n: number }[]>`
    select coalesce(max(round_no), 0)::int as "maxRound", count(*)::int as n from fixtures where stage_id = ${stageId}`;
  const round = opts.round_no ?? maxRound + 1;
  const [{ nextSeq }] = await sql<{ nextSeq: number }[]>`
    select coalesce(max(seq_in_round), 0)::int + 1 as "nextSeq" from fixtures where stage_id = ${stageId} and round_no = ${round}`;
  const [fixture] = await sql<{ id: string }[]>`
    insert into fixtures (stage_id, division_id, round_no, seq_in_round, home_entrant_id, away_entrant_id, ext_key,
                          status, scheduled_at)
    values (${stageId}, ${stage.division_id}, ${round}, ${nextSeq}, ${home}, ${away}, ${"adhoc-" + String(n + 1)},
            'scheduled', ${opts.scheduled_at ?? null})
    returning id`;
  return { fixture_id: fixture!.id };
}
