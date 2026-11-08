// The organiser setup a stage's fixtures can carry BEFORE Start — every kind a delete of the fixture CASCADEs into that
// `stageAttachmentCounts` counts (W4 B2 fix rounds 1 and 2): what Rebuild's confirm names, and what a knockout's Generate
// refuses to redraw over. Written raw, one row per call, so a usecase test need not spell each table's columns. NOT a
// test file (importing a .test file re-registers its tests). Shared by bracket-reconcile.test.ts and
// stage-roster-drift.test.ts.
//
// Each kind exists before Start in the product (fix round 2, item 5 — read from the writers, none gates on the
// division's status): officials, team sheets and device links (round 1); a stream code (the stream panel mints one on
// open, stream-codes.ts) and per-match stream settings (the destination pre-pick); a YouTube broadcast (Go live,
// youtube/prepare.ts); a player's availability answer or check-in (me.ts `setMyAvailability` refuses only a finalized or
// cancelled match, and the player's list is every scheduled match); a Match Day court call (match-day-call.ts refuses
// only a started match).
import { createHash, randomInt, randomUUID } from "node:crypto";
import { sql } from "@/lib/db";
import type { AuthCtx } from "@/server/api-v1/auth";
import { rigApiTarget } from "@/server/relay/__tests__/_session-rig";
import type { StageRosterDrift } from "../stages";

export const STAGE_SETUP_KINDS = [
  "official",
  "lineup",
  "device",
  "stream_code",
  "stream_settings",
  "youtube",
  "availability",
  "call",
] as const;
export type StageSetupKind = (typeof STAGE_SETUP_KINDS)[number];

/** The `attachments` field each kind is counted under. The two stream kinds share one: it counts MATCHES with stream
 *  setup, so a code and a destination on one match are one. */
export const ATTACHMENT_OF: Record<StageSetupKind, keyof StageRosterDrift["attachments"]> = {
  official: "officials",
  lineup: "lineups",
  device: "deviceLinks",
  stream_code: "streams",
  stream_settings: "streams",
  youtube: "youtubeBroadcasts",
  availability: "availability",
  call: "calls",
};

/** V430's code alphabet (`^[0-9a-hjkmnp-tv-z]{12}$`): no i, l, o or u. */
const CODE_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** A person on the fixture's first seated side — a team sheet and an availability answer both name one. An entrant
 *  created by name only (no members) is given one, as an organiser adding a player to it would. */
async function personOn(orgId: string, fixtureId: string): Promise<{ entrantId: string; personId: string }> {
  const [f] = await sql<{ home_entrant_id: string | null; away_entrant_id: string | null }[]>`
    select home_entrant_id, away_entrant_id from fixtures where id = ${fixtureId}`;
  const entrantId = f?.home_entrant_id ?? f?.away_entrant_id;
  if (!entrantId) throw new Error(`rig: fixture ${fixtureId} seats nobody`);
  const [m] = await sql<{ person_id: string }[]>`select person_id from entrant_members where entrant_id = ${entrantId} limit 1`;
  if (m) return { entrantId, personId: m.person_id };
  const [p] = await sql<{ id: string }[]>`
    insert into persons (org_id, full_name) values (${orgId}, ${"Player " + randomUUID().slice(0, 4)}) returning id`;
  await sql`insert into entrant_members (entrant_id, person_id, org_id) values (${entrantId}, ${p!.id}, ${orgId})`;
  return { entrantId, personId: p!.id };
}

/** One row of `kind` on `fixtureId`, in the fixture's org. */
export async function attachStageSetup(auth: AuthCtx, kind: StageSetupKind, fixtureId: string): Promise<void> {
  const orgId = auth.orgId;
  switch (kind) {
    case "official": {
      const [o] = await sql<{ id: string }[]>`
        insert into officials (org_id, display_name) values (${orgId}, ${"Ref " + randomUUID().slice(0, 4)}) returning id`;
      await sql`insert into fixture_officials (fixture_id, official_id, org_id, role_key) values (${fixtureId}, ${o!.id}, ${orgId}, 'referee')`;
      return;
    }
    case "lineup": {
      const { entrantId, personId } = await personOn(orgId, fixtureId);
      await sql`insert into lineups (fixture_id, entrant_id, person_id, org_id) values (${fixtureId}, ${entrantId}, ${personId}, ${orgId})`;
      return;
    }
    case "device":
      await sql`
        insert into device_links (org_id, fixture_id, token_hash, issued_by, expires_at)
        values (${orgId}, ${fixtureId}, ${randomUUID()}, ${auth.userId!}, now() + interval '1 day')`;
      return;
    case "stream_code": {
      const code = Array.from({ length: 12 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
      const tokHash = createHash("sha256").update(randomUUID()).digest("hex");
      await sql`
        insert into fixture_stream_codes (org_id, fixture_id, code, tok_hash, issued_by)
        values (${orgId}, ${fixtureId}, ${code}, ${tokHash}, ${auth.userId!})`;
      return;
    }
    case "stream_settings":
      await sql`insert into fixture_stream_settings (fixture_id, org_id) values (${fixtureId}, ${orgId})`;
      return;
    case "youtube": {
      const { connectionId } = await rigApiTarget(orgId, `Cam ${randomUUID().slice(0, 6)}`);
      await sql`
        insert into youtube_broadcasts (made_for_kids, org_id, connection_id, fixture_id, title, privacy, state)
        values (false, ${orgId}, ${connectionId}, ${fixtureId}, 'Match', 'unlisted', 'created')`;
      return;
    }
    case "availability": {
      const { personId } = await personOn(orgId, fixtureId);
      await sql`
        insert into fixture_availability (fixture_id, person_id, org_id, status) values (${fixtureId}, ${personId}, ${orgId}, 'in')`;
      return;
    }
    case "call": {
      const [venue] = await sql<{ id: string }[]>`
        insert into venues (org_id, name) values (${orgId}, ${"Hall " + randomUUID().slice(0, 4)}) returning id`;
      const [court] = await sql<{ id: string }[]>`
        insert into courts (venue_id, org_id, name, tags) values (${venue!.id}, ${orgId}, 'Court 1', ${sql.array([])}) returning id`;
      await sql`insert into fixture_calls (fixture_id, org_id, court_id) values (${fixtureId}, ${orgId}, ${court!.id})`;
      return;
    }
  }
}
