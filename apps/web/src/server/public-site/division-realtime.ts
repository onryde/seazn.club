import "server-only";
// server/public-site/division-realtime.ts — realtime push nudges (spec 2026-11-24 §4.1, plan Task 12 / T3.2): the competition
// realtime door's answer (`GET /api/v1/public/competitions/{id}/realtime-token`): one subscriber JWT for the competition's
// private `division:{id}` topics (V556 reads its `division_ids` array), so the hub, the slideshow and the board can join them.
//
// Two ways in:
//   - an OFFICIAL (pin 17): a signed-in user with any role in the competition's org, or an ACCEPTED official on a fixture of
//     the competition (`acceptedOfficialInCompetition`, the scoring door's own predicate). No entitlement (officials produce
//     the data), and the divisions come from the base tables, so a private or unpublished competition works; an ARCHIVED
//     division (the product's withdrawal: `archiveDivision` sets `archived_at`) is left out, as the public view leaves it out;
//   - a SPECTATOR: the competition as `public_competitions_v` admits it (public or unlisted), its org holding `realtime`
//     (`org_has_feature`, competition-scoped, as the fixture door asks), and every division `public_divisions_v` lists —
//     live or not yet, so a division going live later needs no re-mint.
// Anyone else: a competition the views do not admit is 404 (a private one stays hidden), a non-entitled one 403.
//
// Every id minted comes from a uuid COLUMN, never from the URL: the URL's id only finds the row (an uppercase spelling of a
// real id still finds it; a slug or other non-uuid is 404 before any read, never a 500 from a uuid cast), and the token's
// `sub` and `division_ids` are the rows' own lowercase ids, which is what `mintDivisionToken` demands.
//
// The token is a secret: it is returned to the caller and nowhere else — never logged, captured, stored, cached or put in a
// URL. What this file logs names the competition and the refusal, never the url, the key or the token.
import { HttpError } from "@/lib/errors";
import { sql } from "@/lib/db";
import { getOrgRole } from "@/lib/auth";
import { mintDivisionToken } from "@/lib/realtime";
import { CompetitionRealtimeToken } from "@/server/api-v1/schemas";
import { log } from "@/server/logger";
import { realtimeConfigRefusal, type RealtimeRefusal } from "@/server/usecases/capture-realtime";
import { REALTIME_UNAVAILABLE } from "@/server/usecases/match-day-realtime";
import { acceptedOfficialInCompetition } from "@/server/usecases/scorers";
import { processRealtimeConfig } from "@/server/usecases/stream-sessions";

/** Plan Task 12: the token lives an hour; the page re-asks at about 50 minutes, or when its channel errors. */
export const DIVISION_TOKEN_TTL_SECONDS = 3600;
/** Plan Task 12 / spec Q5: more divisions than this and the page polls (403 too_many_divisions). */
export const MAX_REALTIME_DIVISIONS = 100;

/** What the door mints and names through. `config` is null when this deployment configures no Supabase. */
export interface DivisionRealtimePort {
  mint(competitionId: string, divisionIds: readonly string[], expiresAt: Date): Promise<string>;
  config(): { url: string; apikey: string } | null;
}
const processPort: DivisionRealtimePort = {
  mint: (competitionId, divisionIds, expiresAt) => mintDivisionToken(competitionId, divisionIds, expiresAt),
  config: processRealtimeConfig,
};

/** Any spelling Postgres reads as a uuid: the URL's id only FINDS the row, so an uppercase one is fine. */
const UUID_ANY_CASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = (): HttpError => new HttpError(404, "competition not found");
const unavailable = (cause?: unknown): HttpError => {
  const err = new HttpError(503, "realtime is not available on this server", REALTIME_UNAVAILABLE);
  if (cause !== undefined) err.cause = cause;
  return err;
};

/** The competition's own id and its divisions' ids, read for the path that admitted the caller. */
interface Admitted {
  competitionId: string;
  divisionIds: string[];
}

/** One more than the cap is read, so "more than 100" is seen without reading a thousand. */
const READ_LIMIT = MAX_REALTIME_DIVISIONS + 1;

/** The official path: the competition's base row, admitted when `userId` holds any org role in its org or an accepted
 *  assignment on one of its fixtures. Null when the competition does not exist or the user is neither. */
async function officialAdmits(urlId: string, userId: string): Promise<Admitted | null> {
  const [comp] = await sql<{ id: string; org_id: string }[]>`select id, org_id from competitions where id = ${urlId}`;
  if (!comp) return null;
  // ANY org role admits, viewer included (plan Task 12 pin 17: "a cookie user with any org role"; controller ruling).
  const admitted = (await getOrgRole(comp.org_id, userId)) !== null || (await acceptedOfficialInCompetition(userId, comp.id));
  if (!admitted) return null;
  const rows = await sql<{ id: string }[]>`
    select id from divisions where competition_id = ${comp.id} and archived_at is null order by created_at, id limit ${READ_LIMIT}`;
  return { competitionId: comp.id, divisionIds: rows.map((r) => r.id) };
}

/** The spectator path: the competition as the public views admit it, 404 when they do not, 403 when its org does not hold
 *  `realtime` for it. */
async function spectatorAdmits(urlId: string): Promise<Admitted> {
  const [comp] = await sql<{ id: string; realtime: boolean }[]>`
    select c.id, org_has_feature(c.org_id, 'realtime', c.id) as realtime
    from public_competitions_v c where c.id = ${urlId}`;
  if (!comp) throw notFound();
  if (comp.realtime !== true) throw new HttpError(403, "realtime not available for this competition");
  const rows = await sql<{ id: string }[]>`
    select id from public_divisions_v where competition_id = ${comp.id} order by created_at, id limit ${READ_LIMIT}`;
  return { competitionId: comp.id, divisionIds: rows.map((r) => r.id) };
}

/**
 * The competition realtime token for the competition the URL names (`urlId`), for the signed-in `userId` (null: anonymous)
 * at `now`. 404 when the id is not a uuid or the caller may not see the competition; 403 when realtime is not theirs here, or
 * when the competition has no division (`no_divisions`: never a token that reads nothing) or more than 100
 * (`too_many_divisions`: the page polls). 503 REALTIME_UNAVAILABLE when no Supabase is configured, the configured one is
 * refused (`realtimeConfigRefusal`, the guard the capture beat and the Match Day door pass), the mint throws, or the answer is
 * not the schema's — never a token for another project, never a half answer. `url` and `apikey` are the PARSED values.
 */
export async function competitionRealtimeFor(
  urlId: string,
  userId: string | null,
  now: Date,
  port: DivisionRealtimePort = processPort,
): Promise<CompetitionRealtimeToken> {
  if (!UUID_ANY_CASE.test(urlId)) throw notFound();
  const admitted = (userId !== null ? await officialAdmits(urlId, userId) : null) ?? (await spectatorAdmits(urlId));
  const { competitionId, divisionIds } = admitted;
  if (divisionIds.length === 0) throw new HttpError(403, "this competition has no division to follow", "no_divisions");
  if (divisionIds.length > MAX_REALTIME_DIVISIONS) {
    throw new HttpError(403, "this competition has too many divisions to follow live", "too_many_divisions");
  }
  const cfg = port.config();
  if (cfg === null) {
    log.warn({ competitionId }, "competition realtime: no Supabase project is configured — no token is served");
    throw unavailable();
  }
  const refused: RealtimeRefusal | null = realtimeConfigRefusal(cfg);
  if (refused !== null) {
    log.warn({ competitionId, refusal: refused }, "competition realtime: the realtime project is refused — no token is served");
    throw unavailable();
  }
  const expiresAt = new Date(now.getTime() + DIVISION_TOKEN_TTL_SECONDS * 1000);
  let token: string;
  try {
    token = await port.mint(competitionId, divisionIds, expiresAt);
  } catch (err) {
    // No token exists to leak: logged here, and reported ONCE by v1() (it captures every >=500 HttpError), which finds the
    // original error as `cause`. No subscription — the page polls.
    log.error({ err: String(err), competitionId }, "competition realtime: the mint failed — no token is served");
    throw unavailable(err);
  }
  const parsed = CompetitionRealtimeToken.safeParse({
    token, divisionIds, expiresAt: Math.floor(expiresAt.getTime() / 1000), url: cfg.url, apikey: cfg.apikey,
  });
  if (!parsed.success) {
    // The issues' PATHS only: an issue can quote its input, and one of these inputs is the token.
    const fields = parsed.error.issues.map((issue) => issue.path.join("."));
    log.warn({ competitionId, refusal: "answer_not_contract" satisfies RealtimeRefusal, fields }, "competition realtime: the answer is not the schema's — no token is served");
    throw unavailable();
  }
  return parsed.data;
}
