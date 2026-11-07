import "server-only";
// Open a match through a Match Day code (capture S4 Match Day design §3, §6, §9.4; MD-1 Task 4): the match's OWN scoring
// link — the printed QR's when it has one — never a second one beside a live one, and nothing revoked. Scope is judged at
// the moment of asking by the one predicate the day read lists by (`inScope`), so the list never offers what the open
// refuses, and a match moved off the code's courts since the list was read is refused.
import { withTenant } from "@/lib/db";
import { HttpError } from "@/lib/errors";
import { siteOrigin } from "@/lib/site-origin";
import { assertUuid } from "@/server/api-v1/auth";
import { CAPTURE_SCORING_LINK_URL_RE } from "@/server/api-v1/capture-schemas";
import { provideSealedLink } from "./device-links";
import { inScope, type ScopeFixture } from "./match-day-code-view";
import { logMatchDayUse, type MatchDayCodeRow } from "./match-day-codes";

/** The open's answer: the link (a credential: the caller's to put on the wire, never logged), "the match is over", or the
 *  refusal the route answers 403 MD_OUT_OF_SCOPE. */
export type MatchDayOpen =
  | { kind: "link"; url: string; sport_key: string }
  | { kind: "finished" }
  | { kind: "refused"; code: "MD_OUT_OF_SCOPE" };

/** The link is built on the site's origin; the phone's parser takes https only (the contract's pattern). */
const HTTPS_ORIGIN = /^https:\/\/[^/]+$/;

type OpenRow = ScopeFixture & { sport_key: string };

/**
 * `code` opens `fixtureId` at `now`. In one tenant transaction:
 *  - the fixture as the code's org sees it (404 when it cannot), its row share-locked so a court move waits for this
 *    open rather than racing its scope check;
 *  - outside the code's scope (competition, venue or courts, and the day) → `{kind: "refused"}`, nothing written;
 *  - `provideSealedLink` under the fixture's link lock, issued by the code's issuer: a finalized or cancelled match is
 *    `{kind: "finished"}` with nothing written; otherwise the live sealed link, or a new one beside it. NEVER a revoke.
 * One `match_day_code_uses` row per link answered, written in the same transaction (`privilegedEpilogue`: the use log is
 * sealed), so a link handed out always has its row.
 */
export async function openMatchForCode(code: MatchDayCodeRow, fixtureId: string, now: Date): Promise<MatchDayOpen> {
  assertUuid(fixtureId, "fixture");
  void now; // scope is the code's own day ([opensAt, expiresAt)); the door already judged `now` against it
  const origin = siteOrigin();
  if (!HTTPS_ORIGIN.test(origin)) throw new HttpError(503, "scoring links need https, and this server's origin is not https");
  type Opened = MatchDayOpen | { kind: "secret"; secret: string; sport_key: string };
  const got = await withTenant(
    code.orgId,
    async (tx): Promise<Opened> => {
      const [row] = await tx<OpenRow[]>`
        select d.competition_id, f.court_id, c.venue_id, f.status, f.scheduled_at, f.finished_at, d.sport_key,
               s.status as stage_status, f.home_entrant_id, f.away_entrant_id, (d.archived_at is null) as division_live
          from fixtures f
          join divisions d on d.id = f.division_id
          join stages s on s.id = f.stage_id
          left join courts c on c.id = f.court_id
         where f.id = ${fixtureId}
           for share of f`;
      if (!row) throw new HttpError(404, "fixture not found");
      if (!inScope(code, row)) return { kind: "refused", code: "MD_OUT_OF_SCOPE" };
      const link = await provideSealedLink(tx, fixtureId, code.issuedBy);
      if (link.kind === "finished") return { kind: "finished" };
      return { kind: "secret", secret: link.secret, sport_key: row.sport_key };
    },
    {
      // Spec §3: every link opened is logged. In the link's own transaction (the use log is sealed, so on the pool's
      // role): a link is never handed out without its row, and a row never written for a link that rolled back.
      privilegedEpilogue: async (tx, opened) => {
        if (opened.kind === "secret") await logMatchDayUse(code.id, { kind: "open", fixtureId }, tx);
      },
    },
  );
  if (got.kind !== "secret") return got;
  const url = `${origin}/score/${got.secret}`;
  // An assumption made a guard: every secret is `mintDeviceLinkSecret`'s and the origin was checked above. Never with
  // the URL in the message.
  if (!CAPTURE_SCORING_LINK_URL_RE.test(url)) throw new Error("openMatchForCode: the scoring link does not match the contract's url pattern");
  return { kind: "link", url, sport_key: got.sport_key };
}
