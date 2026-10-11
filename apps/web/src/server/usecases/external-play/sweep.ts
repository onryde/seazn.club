import "server-only";
// The external-play sweep (chess in-page board design §3.5, §3.6, §4; Task 13).
//
// The 5-minute cron's FOUR jobs, every one of which happens when no page is
// open (spec §4):
//   1. the T+20 no-show      → `core.forfeit {by, reason: "walkover"}`;
//   2. the mint retry         for a create that hit Lichess's 429 wall (M3);
//   3. meeting teardown       at the result, or at T+20 when nobody played;
//   4. the reconcile sweep    a live game nobody is watching.
// The T-10 notice is NOT here: under D12 the organiser's open-round action
// sends the invites and stamps the window (T19).
//
// D12: T+20 is relative to the round being OPENED (`stage_round_opens.opened_at`),
// never to `fixtures.scheduled_at`. A fixture whose round was never opened is
// unreachable here — every job that rules on the window INNER-joins the open.
//
// Every per-fixture action runs in its own try/catch: one fixture's refusal
// is reported in `failures` and never aborts the pass.
import { EngineError } from "@seazn/engine/core";
import { sql } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { FIXTURE_STATUSES } from "@/lib/fixture-status";
import { log } from "@/server/logger";
import { windowFor } from "@/server/external-play/window";
import { getFixtureState } from "../fixtures";
import { scoreEvent } from "../scoring";
import { mintOrgOwnerAuth } from "./auth";
import { loadOnlinePlayFixture, loadSides } from "./guard";
import { isPlayableFixtureStatus } from "./preflight";
import { checkIns } from "./room";

export type SweepJob = "no_show" | "mint_retry" | "teardown" | "reconcile";

export type SweepReport = {
  noShows: number;
  mintRetries: number;
  meetingsEnded: number;
  reconciled: number;
  heldForOrganiser: number;
  /** Candidates examined across every job — a pass that looked at nothing
   *  says so (anti-vacuity), rather than reporting four zeros. */
  scanned: number;
  /** One per fixture whose action threw. A code, never a message: a
   *  message can carry a Lichess body, and the report is returned to the
   *  cron caller. */
  failures: { job: SweepJob; fixtureId: string; code: string }[];
};

export type SweepDeps = {
  now?: Date;
  /** TEST SEAM — scope every job to these orgs. Production passes none and
   *  sweeps every org; the shared test database holds other suites' opened
   *  rounds, which an unscoped sweep would act on. */
  orgIds?: readonly string[];
};

/** The window a board is playable in, anchored on the ROUND being opened
 *  (D12). Gate B (2026-10-11): every merged reader — T9's create, T8's seat
 *  and room, T19's invite and openRound — judges it as
 *  `roomPhase(now, roundOpenedAt)`, so the deadline is window.ts's own
 *  `windowFor(opened).deadline` (opened + DEADLINE_AFTER_MS). `opensAt` is
 *  the open itself: before it nothing exists to play. */
export function playableWindow(roundOpenedAt: Date): { opensAt: Date; deadline: Date } {
  return { opensAt: roundOpenedAt, deadline: windowFor(roundOpenedAt).deadline };
}

/** T8's predicate, as the SQL list the candidate queries filter on — derived,
 *  so the two can never disagree. */
const PLAYABLE_STATUSES: readonly string[] = FIXTURE_STATUSES.filter(isPlayableFixtureStatus);

function codeOf(err: unknown): string {
  if (err instanceof HttpError) return err.code ?? `HTTP_${err.status}`;
  if (err instanceof EngineError) return err.code;
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code !== "") return code;
  return err instanceof Error ? err.name : "UNKNOWN";
}

type Pass = { now: Date; orgIds: readonly string[] | undefined; report: SweepReport };

async function each<T extends { fixtureId: string }>(
  pass: Pass,
  job: SweepJob,
  rows: readonly T[],
  act: (row: T) => Promise<void>,
): Promise<void> {
  pass.report.scanned += rows.length;
  for (const row of rows) {
    try {
      await act(row);
    } catch (err) {
      const code = codeOf(err);
      pass.report.failures.push({ job, fixtureId: row.fixtureId, code });
      log.warn({ job, fixtureId: row.fixtureId, code }, "external-play sweep: a fixture's action failed");
    }
  }
}

function orgScope(pass: Pass) {
  return pass.orgIds === undefined ? sql`` : sql`and f.org_id in ${sql(pass.orgIds as string[])}`;
}

// ─── Job 1: the T+20 no-show ───────────────────────────────────────────────
//
// A board is a no-show candidate only when its round was OPENED (inner join),
// the round's window has closed, the fixture is still playable, and no game
// is — or may be — on file: no bridge row, or a `pending` one with no
// challenge, no possibly-sent create (`create_sent_at`, T9 I2) and no live
// mint claim (a create in flight past the deadline is T9's to finish).

type NoShowCandidate = { fixtureId: string; openedAt: Date };

async function noShowCandidates(pass: Pass): Promise<NoShowCandidate[]> {
  return sql<NoShowCandidate[]>`
    select f.id as "fixtureId", o.opened_at as "openedAt"
      from fixtures f
      join divisions d on d.id = f.division_id
      join stage_round_opens o on o.stage_id = f.stage_id and o.round_no = f.round_no
      left join fixture_external_play ep on ep.fixture_id = f.id
     where d.sport_key = 'boardgame'
       and coalesce(d.config->>'onlinePlay', 'off') = 'lichess'
       and f.status in ${sql(PLAYABLE_STATUSES as string[])}
       and (ep.fixture_id is null
            or (ep.status = 'pending' and ep.challenge_id is null and ep.create_sent_at is null))
       ${orgScope(pass)}
     order by o.opened_at, f.id`;
}

async function noShow(pass: Pass, c: NoShowCandidate): Promise<void> {
  if (pass.now.getTime() < playableWindow(c.openedAt).deadline.getTime()) return;
  const f = await loadOnlinePlayFixture(c.fixtureId);
  if (!f || !isPlayableFixtureStatus(f.fixtureStatus)) return;
  const { home, away } = await loadSides(f);
  const came = await checkIns(f, home, away, c.openedAt);
  if (came.home && came.away) return;
  const by = !came.home && !came.away ? "both" : !came.home ? f.homeEntrantId : f.awayEntrantId;
  const auth = await mintOrgOwnerAuth(f.orgId);
  const state = await getFixtureState(auth, f.fixtureId);
  await scoreEvent(auth, f.fixtureId, {
    expected_seq: state.last_seq,
    type: "core.forfeit",
    payload: { by, reason: "walkover" },
    idempotency_key: `extplay-noshow:${f.fixtureId}`,
  });
  pass.report.noShows++;
}

// ─── The pass ──────────────────────────────────────────────────────────────

export async function sweepExternalPlay(deps: SweepDeps = {}): Promise<SweepReport> {
  const report: SweepReport = {
    noShows: 0,
    mintRetries: 0,
    meetingsEnded: 0,
    reconciled: 0,
    heldForOrganiser: 0,
    scanned: 0,
    failures: [],
  };
  // An empty scope is a scope with nothing in it — never "every org".
  if (deps.orgIds !== undefined && deps.orgIds.length === 0) return report;
  const pass: Pass = { now: deps.now ?? new Date(), orgIds: deps.orgIds, report };

  await each(pass, "no_show", await noShowCandidates(pass), (c) => noShow(pass, c));
  return report;
}
